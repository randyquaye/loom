import Foundation
import Network
import XCTest
@testable import Loom

/// A local runner speaking the real frame protocol over a real WebSocket, on loopback only.
final class FakeRunner: @unchecked Sendable {
    struct Call {
        let id: Int
        let channel: String
        let input: Any?
        let connection: NWConnection
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "fake-runner")
    private let lock = NSLock()
    private var live: [NWConnection] = []
    private var accepted = 0
    private var received: [[String: Any]] = []
    private var answers: [String: (FakeRunner, Call) -> Void] = [:]
    private var upgrades: [[String: String]] = []

    /// What the runner says it speaks in its hello (RUNNER_PROTOCOL).
    var helloProtocol = 6
    /// What this runner supports (SERVER_CAPABILITIES). As src/main/runner/server.ts does, its
    /// hello grants the intersection with what the upgrade's `x-loom-capabilities` asked for.
    var supportedCapabilities = ["bots.v1", "subscriptions.v1", "mobile.v1"]
    /// A runner from before capabilities: its hello has no `capabilities` field at all.
    var helloOmitsCapabilities = false
    /// Closes each connection with this code right after its hello.
    var closeAfterHello: Int?
    private(set) var port: UInt16 = 0
    private let upgradeHeaders: Locked<[[String: String]]>

    init(identity: SecIdentity? = nil) throws {
        let parameters: NWParameters
        if let identity {
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(tls.securityProtocolOptions, sec_identity_create(identity)!)
            parameters = NWParameters(tls: tls)
        } else {
            parameters = NWParameters.tcp
        }
        let sockets = NWProtocolWebSocket.Options()
        sockets.autoReplyPing = true
        sockets.maximumMessageSize = 64 * 1024 * 1024
        let upgradeLog = Locked<[[String: String]]>([])
        sockets.setClientRequestHandler(DispatchQueue(label: "fake-runner-upgrade")) { _, headers in
            upgradeLog.update { $0.append(Dictionary(headers.map { ($0.name.lowercased(), $0.value) }) { _, last in last }) }
            return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
        }
        upgradeHeaders = upgradeLog
        parameters.defaultProtocolStack.applicationProtocols.insert(sockets, at: 0)
        // Loopback only: nothing outside this simulator can reach a fixture.
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        port = try XCTUnwrap(listener.port?.rawValue, "the fake runner could not listen")
    }

    deinit { stop() }

    func stop() {
        listener.cancel()
        dropAll()
    }

    var url: URL { URL(string: "ws://127.0.0.1:\(port)/v1/ws")! }
    var connectionCount: Int { lock.withLock { accepted } }
    var frames: [[String: Any]] { lock.withLock { received } }
    /// Each accepted upgrade's request headers, names lowercased.
    var upgradeRequests: [[String: String]] { upgradeHeaders.value }
    /// Frames other than hello: every call any client sent.
    var calls: [[String: Any]] { frames.filter { $0["type"] as? String == "call" } }
    func frames(for channel: String) -> [[String: Any]] { frames.filter { $0["channel"] as? String == channel } }

    /// Answers every call on a channel; unanswered channels stay silent, as a stalled runner would.
    func on(_ channel: String, _ answer: @escaping (FakeRunner, Call) -> Void) {
        lock.withLock { answers[channel] = answer }
    }

    func reply(_ channel: String, json: String) {
        on(channel) { runner, call in runner.result(call, json: json) }
    }

    func result(_ call: Call, json: String = "null") {
        send(#"{"type":"result","id":\#(call.id),"ok":true,"value":\#(json)}"#, on: call.connection)
    }

    func fail(_ call: Call, _ message: String) {
        send(#"{"type":"result","id":\#(call.id),"ok":false,"error":"\#(message)"}"#, on: call.connection)
    }

    func push(_ channel: String, json: String) {
        for connection in lock.withLock({ live }) {
            send(#"{"type":"push","channel":"\#(channel)","payload":\#(json)}"#, on: connection)
        }
    }

    func send(_ text: String, on connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .idempotent)
    }

    func closeAll(code: Int) {
        for connection in lock.withLock({ live }) { close(connection, code: code) }
    }

    /// The network going away: no close frame, just an ended connection.
    func dropAll() {
        let connections = lock.withLock { () -> [NWConnection] in
            defer { live.removeAll() }
            return live
        }
        for connection in connections { connection.cancel() }
    }

    private func close(_ connection: NWConnection, code: Int) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
        metadata.closeCode = .privateCode(UInt16(code))
        let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
        // As a real runner does: the close frame goes out, and the socket ends once the peer has
        // had time to read it (the receive loop ends it sooner when the peer hangs up).
        connection.send(content: nil, contentContext: context, isComplete: true, completion: .idempotent)
        queue.asyncAfter(deadline: .now() + 1) { connection.cancel() }
    }

    private func accept(_ connection: NWConnection) {
        lock.withLock {
            accepted += 1
            live.append(connection)
        }
        connection.start(queue: queue)
        receive(on: connection)
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, error == nil else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if metadata?.opcode == .close {
                self.lock.withLock { self.live.removeAll { $0 === connection } }
                connection.cancel()
                return
            }
            if let data, metadata?.opcode == .text,
               let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                self.handle(frame, on: connection)
            }
            self.receive(on: connection)
        }
    }

    private func handle(_ frame: [String: Any], on connection: NWConnection) {
        lock.withLock { received.append(frame) }
        if frame["type"] as? String == "hello" {
            let requested = (upgradeRequests.last?["x-loom-capabilities"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            let granted = supportedCapabilities.filter(requested.contains)
            let list = granted.map { "\"\($0)\"" }.joined(separator: ",")
            send(helloOmitsCapabilities ? #"{"type":"hello","protocol":\#(helloProtocol)}"# : #"{"type":"hello","protocol":\#(helloProtocol),"capabilities":[\#(list)]}"#, on: connection)
            if (frame["protocol"] as? Int) != helloProtocol { return close(connection, code: 4400) }
            if let code = closeAfterHello { close(connection, code: code) }
            return
        }
        guard frame["type"] as? String == "call", let id = frame["id"] as? Int, let channel = frame["channel"] as? String else { return }
        let answer = lock.withLock { answers[channel] }
        answer?(self, Call(id: id, channel: channel, input: frame["input"], connection: connection))
    }
}

/// A byte-level loopback server: records exactly what a client sent, optionally over TLS.
final class RawServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "raw-server")
    private let lock = NSLock()
    private var buffers: [Data] = []
    private var handshakes = 0
    private let respond: (Data) -> Data?
    private(set) var port: UInt16 = 0

    /// `respond` sees everything one connection has sent so far; a non-nil answer is written and the connection closed.
    init(identity: SecIdentity? = nil, respond: @escaping (Data) -> Data?) throws {
        self.respond = respond
        let parameters: NWParameters
        if let identity {
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(tls.securityProtocolOptions, sec_identity_create(identity)!)
            parameters = NWParameters(tls: tls)
        } else {
            parameters = NWParameters.tcp
        }
        // Loopback only: nothing outside this simulator can reach a fixture.
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        port = try XCTUnwrap(listener.port?.rawValue, "the raw server could not listen")
    }

    deinit { listener.cancel() }

    /// Application bytes each connection delivered, in order of arrival. TLS handshakes are not counted.
    var received: [Data] { lock.withLock { buffers } }
    var applicationBytes: Int { received.reduce(0) { $0 + $1.count } }
    /// Connections whose transport (TLS included) completed on the server side.
    var completedHandshakes: Int { lock.withLock { handshakes } }

    private func accept(_ connection: NWConnection) {
        let index = lock.withLock { () -> Int in
            buffers.append(Data())
            return buffers.count - 1
        }
        connection.stateUpdateHandler = { [weak self] state in
            if case .ready = state { self?.lock.withLock { self?.handshakes += 1 } }
        }
        connection.start(queue: queue)
        read(connection, index)
    }

    private func read(_ connection: NWConnection, _ index: Int) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                let soFar = self.lock.withLock { () -> Data in
                    self.buffers[index].append(data)
                    return self.buffers[index]
                }
                if let answer = self.respond(soFar) {
                    connection.send(content: answer, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
                        connection.cancel()
                    })
                    return
                }
            }
            if complete || error != nil { return connection.cancel() }
            self.read(connection, index)
        }
    }

    static func http(_ status: String, headers: [String] = [], body: String = "") -> Data {
        let lines = ["HTTP/1.1 \(status)", "Content-Length: \(body.utf8.count)", "Connection: close"] + headers
        return Data((lines.joined(separator: "\r\n") + "\r\n\r\n" + body).utf8)
    }

    /// True once a whole HTTP request (headers and declared body) has arrived.
    static func requestComplete(_ data: Data) -> Bool {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return false }
        let head = String(decoding: data[..<end.lowerBound], as: UTF8.self).lowercased()
        let length = head.split(separator: "\r\n").first { $0.hasPrefix("content-length:") }
            .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
        return data.count - end.upperBound >= length
    }
}

/// Collects a connection's ordered events so tests can wait on them.
final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var seenStates: [ConnectionState] = []
    private var seenPushes: [(channel: String, frame: Data)] = []
    private var task: Task<Void, Never>?

    init(_ connection: RunnerConnection) {
        let events = connection.events
        task = Task { [weak self] in
            for await next in events {
                guard let self else { return }
                self.lock.withLock {
                    switch next {
                    case .state(let state): self.seenStates.append(state)
                    case .push(let channel, let frame): self.seenPushes.append((channel, frame))
                    }
                }
            }
        }
    }

    deinit { task?.cancel() }

    var states: [ConnectionState] { lock.withLock { seenStates } }
    var state: ConnectionState? { states.last }
    var pushes: [(channel: String, frame: Data)] { lock.withLock { seenPushes } }
}

final class StubTokens: TokenSource, @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: [String?]
    private var invalidated = 0
    private var asked = 0
    var failure: Error?

    /// Each invalidation moves on to the next token, as a refresh would; nil means signed out.
    init(_ tokens: [String?]) { remaining = tokens }

    var invalidations: Int { lock.withLock { invalidated } }
    var requests: Int { lock.withLock { asked } }

    func accessToken() async throws -> String? {
        if let failure { throw failure }
        return lock.withLock {
            asked += 1
            return remaining.first ?? nil
        }
    }

    func invalidateAccess() async {
        lock.withLock {
            invalidated += 1
            if remaining.count > 1 { remaining.removeFirst() }
        }
    }
}

/// A value shared between a test and the queues it drives.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value { lock.withLock { stored } }

    @discardableResult
    func update<Result>(_ change: (inout Value) -> Result) -> Result {
        lock.withLock { change(&stored) }
    }
}
