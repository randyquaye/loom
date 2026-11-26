import Network
import XCTest
@testable import Loom

/// A socket whose events the test drives by hand, for orderings a real socket cannot produce.
private final class ScriptedSocket: RunnerSocket, @unchecked Sendable {
    let events: AsyncStream<SocketEvent>
    private let feed: AsyncStream<SocketEvent>.Continuation
    private let lock = NSLock()
    private var written: [Data] = []
    private(set) var closed = false

    init() { (events, feed) = AsyncStream.makeStream(of: SocketEvent.self) }

    var sent: [[String: Any]] {
        lock.withLock { written }.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    func send(_ frame: Data) async throws { lock.withLock { written.append(frame) } }
    /// Closing does not silence it: late callbacks from a dead socket are the case under test.
    func close() { closed = true }
    func emit(_ text: String) { feed.yield(.frame(Data(text.utf8))) }
    func emitClose(_ code: Int?) { feed.yield(.closed(code: code)) }
}

private struct WorkspaceInput: Encodable { let workspaceId: String }
private struct SendInput: Encodable {
    let sessionId: String
    let text: String
    let attachments: [String]
    let messageId: String
}

final class RunnerConnectionTests: XCTestCase {
    private var runner: FakeRunner!
    private var connections: [RunnerConnection] = []

    override func setUpWithError() throws { runner = try FakeRunner() }

    override func tearDown() async throws {
        for connection in connections { await connection.shutdown() }
        connections = []
        runner.stop()
    }

    private func connect(
        tokens: StubTokens = StubTokens(["token-1"]),
        callDeadline: TimeInterval = 5,
        open: ((String) async throws -> RunnerSocket)? = nil
    ) -> (RunnerConnection, EventLog) {
        let url = runner.url
        let connection = RunnerConnection(
            tokens: tokens,
            open: open ?? { bearer in try await WebSocketChannel.openForTests(url: url, bearer: bearer) },
            callDeadline: callDeadline,
            retryFirst: 0.05
        )
        connections.append(connection)
        return (connection, EventLog(connection))
    }

    func testHelloThenCallsResultsErrorsAndPushes() async throws {
        runner.reply("app:ping", json: #""pong""#)
        runner.reply("workspaces:power", json: #"{"state":"running","error":null}"#)
        runner.on("files:read") { runner, call in runner.fail(call, "binary file: logo.png") }
        let (connection, log) = connect()
        await connection.resume()
        await waitUntil(message: "connected") { log.state == .connected }

        XCTAssertEqual(runner.frames.first?["type"] as? String, "hello")
        XCTAssertEqual(runner.frames.first?["protocol"] as? Int, 6, "the stable base protocol; additions are capabilities")
        XCTAssertEqual(runner.upgradeRequests.first?["x-loom-capabilities"], "bots.v1,mobile.v1")

        let pong: String = try await connection.call("app:ping")
        XCTAssertEqual(pong, "pong")
        XCTAssertNil(runner.frames(for: "app:ping")[0]["input"], "a call without input sends none")

        let power: WorkspacePower = try await connection.call("workspaces:power", WorkspaceInput(workspaceId: "w1"))
        XCTAssertEqual(power, WorkspacePower(state: "running", error: nil))
        XCTAssertEqual(runner.frames(for: "workspaces:power")[0]["input"] as? [String: String], ["workspaceId": "w1"])

        await XCTAssertThrowsAsync(try await connection.send("files:read", WorkspaceInput(workspaceId: "w1"))) {
            XCTAssertEqual($0 as? RunnerCallError, .refused("binary file: logo.png"))
        }

        runner.push("workspaces:powerChanged", json: #"{"workspaceId":"w1","state":"stopped","error":null}"#)
        await waitUntil(message: "push") { log.pushes.count == 1 }
        XCTAssertEqual(log.pushes[0].channel, "workspaces:powerChanged")
        let push = try JSONDecoder().decode(PushPayload<WorkspacePowerPush>.self, from: log.pushes[0].frame).payload
        XCTAssertEqual(push.workspaceId, "w1")
        XCTAssertEqual(push.state, "stopped")
    }

    func testAnotherProtocolVersionEndsInUpdateRequired() async throws {
        runner.helloProtocol = 7
        let (connection, log) = connect()
        await connection.resume()
        await waitUntil(message: "update state") { if case .update = log.state { return true } else { return false } }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(runner.connectionCount, 1, "a version mismatch is not retried")
        await XCTAssertThrowsAsync(try await connection.send("app:ping")) {
            XCTAssertEqual($0 as? RunnerCallError, .unreachable)
        }
    }

    /// A protocol 6 runner that predates mobile support: nothing may be asked of it, not even a
    /// message that was waiting for the connection.
    func testRunnerWithoutMobileCapabilityIsUpdateRequiredBeforeAnyCall() async throws {
        runner.supportedCapabilities = ["bots.v1", "subscriptions.v1"]
        runner.reply("projects:list", json: "[]")
        let (connection, log) = connect()
        await connection.resume()
        let waiting = Task {
            try await connection.send("sessions:send", SendInput(sessionId: "s1", text: "hi", attachments: [], messageId: "0b6d3c1e-0000-4000-8000-000000000002"), identified: true)
        }
        await waitUntil(message: "update state") { if case .update = log.state { return true } else { return false } }
        await XCTAssertThrowsAsync(try await waiting.value)
        await XCTAssertThrowsAsync(try await connection.call("projects:list", as: [ProjectRow].self)) {
            XCTAssertEqual($0 as? RunnerCallError, .unreachable)
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(runner.upgradeRequests.first?["x-loom-capabilities"], "bots.v1,mobile.v1")
        XCTAssertTrue(runner.calls.isEmpty, "no RPC reaches a runner that did not grant mobile.v1")
        XCTAssertEqual(runner.connectionCount, 1, "an update notice is not retried on its own")
        XCTAssertFalse(log.states.contains(.connected))
    }

    func testRunnerFromBeforeCapabilitiesIsUpdateRequired() async throws {
        runner.helloOmitsCapabilities = true
        let (connection, log) = connect()
        await connection.resume()
        await waitUntil(message: "update state") { if case .update = log.state { return true } else { return false } }
        XCTAssertTrue(runner.calls.isEmpty)
    }

    /// Bots are optional: a runner without them is used, and simply lists no bot workspaces.
    func testMissingBotsCapabilityIsHonoredNotRequired() async throws {
        runner.supportedCapabilities = ["mobile.v1"]
        runner.reply("app:ping", json: #""pong""#)
        let (connection, log) = connect()
        await connection.resume()
        await waitUntil(message: "connected") { log.state == .connected }
        let pong: String = try await connection.call("app:ping")
        XCTAssertEqual(pong, "pong")
    }

    func testSignedOutCloseRefreshesOnceThenStops() async throws {
        runner.closeAfterHello = 4401
        let tokens = StubTokens(["stale", "renewed"])
        let (connection, log) = connect(tokens: tokens)
        await connection.resume()
        await waitUntil(message: "signed out") { log.state == .signedOut }
        XCTAssertEqual(tokens.invalidations, 1, "exactly one fresh token is tried")
        XCTAssertEqual(runner.connectionCount, 2)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(runner.connectionCount, 2, "no loop after the second refusal")
    }

    func testNoTokenMeansSignedOutWithoutConnecting() async {
        let (connection, log) = connect(tokens: StubTokens([nil]))
        await connection.resume()
        await waitUntil(message: "signed out") { log.state == .signedOut }
        XCTAssertEqual(runner.connectionCount, 0)
    }

    func testRejectedUpgradeTriesOneFreshTokenAndStaysRetryable() async {
        let tokens = StubTokens(["stale", "renewed"])
        let bearers = Locked<[String]>([])
        let (connection, log) = connect(tokens: tokens, open: { bearer in
            bearers.update { $0.append(bearer) }
            throw SocketOpenError.rejected
        })
        await connection.resume()
        await waitUntil(message: "several attempts") { bearers.value.count >= 4 }
        XCTAssertEqual(tokens.invalidations, 1)
        XCTAssertEqual(Array(bearers.value.prefix(3)), ["stale", "renewed", "renewed"])
        XCTAssertFalse(log.states.contains(.signedOut), "only the token endpoint or a 4401 close ends a sign-in")
        XCTAssertTrue(log.states.contains(.unreachable))
    }

    func testUnreachableRunnerIsRetriedWithoutTouchingTheToken() async {
        let tokens = StubTokens(["token-1"])
        let url = runner.url
        let attempts = Locked(0)
        let (connection, log) = connect(tokens: tokens, open: { bearer in
            if attempts.update({ $0 += 1; return $0 }) < 3 { throw SocketOpenError.unreachable }
            return try await WebSocketChannel.openForTests(url: url, bearer: bearer)
        })
        await connection.resume()
        await waitUntil(message: "connected after retries") { log.state == .connected }
        XCTAssertEqual(attempts.value, 3)
        XCTAssertEqual(tokens.invalidations, 0)
        XCTAssertEqual(log.states.filter { $0 == .unreachable }.count, 2)
    }

    func testDisconnectFailsOrdinaryCallsAndReplaysIdentifiedSendsUnchanged() async throws {
        let sends = Locked(0)
        runner.on("sessions:send") { runner, call in
            if sends.update({ $0 += 1; return $0 }) == 1 { runner.dropAll() } else { runner.result(call) }
        }
        let (connection, log) = connect()
        await connection.resume()
        await waitUntil(message: "connected") { log.state == .connected }

        let reading = Task { try await connection.send("files:read", WorkspaceInput(workspaceId: "w1")) }
        await waitUntil(message: "read sent") { self.runner.frames(for: "files:read").count == 1 }
        let message = SendInput(sessionId: "s1", text: "hello", attachments: [], messageId: "0b6d3c1e-0000-4000-8000-000000000001")
        try await connection.send("sessions:send", message, identified: true)

        await XCTAssertThrowsAsync(try await reading.value) {
            XCTAssertEqual($0 as? RunnerCallError, .unreachable)
        }
        let frames = runner.frames(for: "sessions:send")
        XCTAssertEqual(frames.count, 2, "sent again after the reconnect")
        XCTAssertEqual(frames[0]["id"] as? Int, frames[1]["id"] as? Int)
        XCTAssertEqual((frames[0]["input"] as? [String: Any])?["messageId"] as? String, message.messageId)
        XCTAssertEqual((frames[1]["input"] as? [String: Any])?["messageId"] as? String, message.messageId)
        XCTAssertEqual(runner.frames(for: "files:read").count, 1, "an ordinary call is never replayed")
        XCTAssertEqual(runner.connectionCount, 2)
    }

    func testCallsFailImmediatelyWhileDisconnected() async {
        let (connection, _) = connect()
        await XCTAssertThrowsAsync(try await connection.send("workspaces:stop", WorkspaceInput(workspaceId: "w1"))) {
            XCTAssertEqual($0 as? RunnerCallError, .unreachable)
        }
        XCTAssertTrue(runner.frames.isEmpty)
    }

    func testUnansweredCallMeetsItsDeadline() async throws {
        runner.reply("app:ping", json: #""pong""#)
        let stalled = Locked<FakeRunner.Call?>(nil)
        runner.on("git:status") { _, call in stalled.update { $0 = call } }
        let (connection, log) = connect(callDeadline: 0.3)
        await connection.resume()
        await waitUntil(message: "connected") { log.state == .connected }

        let began = Date()
        await XCTAssertThrowsAsync(try await connection.send("git:status", WorkspaceInput(workspaceId: "w1"))) {
            XCTAssertEqual($0 as? RunnerCallError, .timedOut)
        }
        XCTAssertLessThan(Date().timeIntervalSince(began), 3)

        // The answer arriving late is ignored, and the connection keeps working.
        runner.result(try XCTUnwrap(stalled.value), json: "[]")
        let pong: String = try await connection.call("app:ping")
        XCTAssertEqual(pong, "pong")
        XCTAssertEqual(log.state, .connected)
    }

    func testCallbacksFromASupersededSocketAreIgnored() async throws {
        let first = ScriptedSocket()
        let second = ScriptedSocket()
        let sockets = Locked([first, second])
        let tokens = StubTokens(["token-1", "token-2"])
        let (connection, log) = connect(tokens: tokens, open: { _ in sockets.update { $0.removeFirst() } })
        await connection.resume()
        await waitUntil(message: "hello sent") { first.sent.count == 1 }
        first.emit(#"{"type":"hello","protocol":6,"capabilities":["bots.v1","mobile.v1"]}"#)
        await waitUntil(message: "connected") { log.state == .connected }

        let pending = Task { try await connection.call("app:ping", as: String.self) }
        await waitUntil(message: "call sent") { first.sent.count == 2 }
        await connection.reconnectNow()
        await waitUntil(message: "second hello") { second.sent.count == 1 }
        second.emit(#"{"type":"hello","protocol":6,"capabilities":["bots.v1","mobile.v1"]}"#)
        await waitUntil(message: "reconnected") { log.states.filter { $0 == .connected }.count == 2 }
        await XCTAssertThrowsAsync(try await pending.value) { XCTAssertEqual($0 as? RunnerCallError, .unreachable) }
        XCTAssertTrue(first.closed)

        // The dead socket now speaks: none of it may reach the store or the session.
        first.emit(#"{"type":"push","channel":"session:event","payload":{"sessionId":"s1","seq":1,"event":{"type":"text.done","turnId":"t","text":"stale"}}}"#)
        first.emit(#"{"type":"result","id":1,"ok":true,"value":"pong"}"#)
        first.emit(#"{"type":"hello","protocol":3}"#)
        first.emitClose(4401)
        second.emit(#"{"type":"push","channel":"session:activity","payload":{"revision":2,"bySession":{}}}"#)
        await waitUntil(message: "live push") { log.pushes.count == 1 }
        XCTAssertEqual(log.pushes.map(\.channel), ["session:activity"])
        XCTAssertEqual(log.state, .connected)
        XCTAssertEqual(tokens.invalidations, 0)
    }

    func testSuspendClosesTheSocketAndResumeReconnects() async throws {
        let (connection, log) = connect()
        await connection.resume()
        await waitUntil(message: "connected") { log.state == .connected }
        let waiting = Task { try await connection.send("git:status", WorkspaceInput(workspaceId: "w1")) }
        await waitUntil(message: "call sent") { self.runner.frames(for: "git:status").count == 1 }

        await connection.suspend()
        await waitUntil(message: "idle") { log.state == .idle }
        await XCTAssertThrowsAsync(try await waiting.value) { XCTAssertEqual($0 as? RunnerCallError, .unreachable) }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(runner.connectionCount, 1, "nothing reconnects while suspended")

        await connection.resume()
        await waitUntil(message: "reconnected") { log.state == .connected }
        XCTAssertEqual(runner.connectionCount, 2)
    }

    // MARK: The real socket

    func testUpgradeCarriesTheBearerAndNoOrigin() async throws {
        let server = try RawServer { _ in nil }
        let url = URL(string: "ws://127.0.0.1:\(server.port)/v1/ws")!
        await XCTAssertThrowsAsync(try await WebSocketChannel.openForTests(url: url, bearer: "loom_at_test", deadline: 0.5))
        let request = String(decoding: server.received.first ?? Data(), as: UTF8.self)
        XCTAssertTrue(request.hasPrefix("GET /v1/ws HTTP/1.1\r\n"), request)
        let headers = request.lowercased()
        XCTAssertTrue(headers.contains("authorization: bearer loom_at_test\r\n"), request)
        XCTAssertTrue(headers.contains("\r\nx-loom-capabilities: bots.v1,mobile.v1\r\n"), request)
        XCTAssertFalse(headers.contains("\r\norigin:"), "the runner refuses any connection that names an origin")
    }

    func testFramesOverSixteenMegabytesEndTheConnection() async throws {
        let (connection, log) = connect()
        await connection.resume()
        await waitUntil(message: "connected") { log.state == .connected }
        let oversized = String(repeating: "x", count: WebSocketChannel.maxFrameBytes + 1024)
        runner.push("session:event", json: "\"\(oversized)\"")
        await waitUntil(15, message: "connection dropped") { log.states.contains(.unreachable) || self.runner.connectionCount > 1 }
        XCTAssertTrue(log.pushes.isEmpty)
    }
}
