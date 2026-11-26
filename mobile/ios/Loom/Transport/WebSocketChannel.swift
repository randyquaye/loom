import Foundation
import Network

enum SocketEvent: Equatable {
    case frame(Data)
    /// The socket ended. The code is the runner's close code, when it sent one.
    case closed(code: Int?)
}

enum SocketOpenError: Error, Equatable {
    /// TLS reached the proven runner, which then turned the upgrade away: the token may be stale.
    case rejected
    /// No connection to a proven runner could be made. Says nothing about the sign-in.
    case unreachable
}

/// The seam between the runner protocol and the socket that carries it (the Adapter): the
/// connection logic knows frames and close codes, not Network.framework.
protocol RunnerSocket: AnyObject, Sendable {
    /// Frames in arrival order, ending with at most one `closed`.
    var events: AsyncStream<SocketEvent> { get }
    func send(_ frame: Data) async throws
    func close()
}

/// A WebSocket over Network.framework. Production sockets are only ever opened by
/// `PinnedTransport`, on TLS parameters that pin the runner's signed key.
final class WebSocketChannel: RunnerSocket, @unchecked Sendable {
    /// The runner's own frame bound.
    static let maxFrameBytes = 16 * 1024 * 1024
    /// The runner pings every 30 seconds; this much silence means the connection is dead.
    private static let silence: TimeInterval = 70
    private static let pingEvery: TimeInterval = 25

    let events: AsyncStream<SocketEvent>
    private let feed: AsyncStream<SocketEvent>.Continuation
    private let connection: NWConnection
    private let queue: DispatchQueue
    private var finished = false
    private var lastHeard = Date()
    private var timer: DispatchSourceTimer?

    private init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
        (events, feed) = AsyncStream.makeStream(of: SocketEvent.self)
    }

    /// Completes once the upgrade has succeeded. `parameters` decide the transport security.
    static func open(
        url: URL,
        parameters: NWParameters,
        bearer: String,
        witness: HandshakeWitness?,
        deadline: TimeInterval = 15
    ) async throws -> WebSocketChannel {
        let sockets = NWProtocolWebSocket.Options()
        sockets.autoReplyPing = true
        sockets.maximumMessageSize = maxFrameBytes
        // The bearer and the optional protocol additions this app asks for. No Origin: the runner
        // refuses any connection that names one.
        sockets.setAdditionalHeaders([
            ("Authorization", "Bearer \(bearer)"),
            ("x-loom-capabilities", RunnerConnection.requestedCapabilities.joined(separator: ","))
        ])
        parameters.defaultProtocolStack.applicationProtocols.insert(sockets, at: 0)
        let queue = DispatchQueue(label: "dev.loom.app.ios.websocket")
        let connection = NWConnection(to: .url(url), using: parameters)
        let channel = WebSocketChannel(connection: connection, queue: queue)

        final class Outcome: @unchecked Sendable {
            var continuation: CheckedContinuation<Void, Error>?
        }
        let outcome = Outcome()
        func settle(_ result: Result<Void, Error>) {
            guard let continuation = outcome.continuation else { return }
            outcome.continuation = nil
            if case .failure = result {
                connection.stateUpdateHandler = nil
                connection.cancel()
            }
            continuation.resume(with: result)
        }
        // Reached the proven runner and was still refused: that is about the token.
        let failure: () -> SocketOpenError = { witness?.verified == true ? .rejected : .unreachable }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                queue.async { [weak channel] in
                    outcome.continuation = continuation
                    connection.stateUpdateHandler = { state in
                        switch state {
                        case .ready:
                            connection.stateUpdateHandler = { later in
                                switch later {
                                case .failed, .cancelled: channel?.endedWithoutCode()
                                default: break
                                }
                            }
                            settle(.success(()))
                        case .failed, .waiting, .cancelled: settle(.failure(failure()))
                        default: break
                        }
                    }
                    connection.start(queue: queue)
                    queue.asyncAfter(deadline: .now() + deadline) { settle(.failure(failure())) }
                }
            }
        } onCancel: {
            queue.async { settle(.failure(SocketOpenError.unreachable)) }
        }
        queue.async { channel.started() }
        return channel
    }

    #if DEBUG
    /// Plain TCP to a loopback fixture. Compiled out of release builds: there is no unpinned socket there.
    static func openForTests(url: URL, bearer: String, deadline: TimeInterval = 5) async throws -> WebSocketChannel {
        try await open(url: url, parameters: .tcp, bearer: bearer, witness: nil, deadline: deadline)
    }
    #endif

    private func started() {
        lastHeard = Date()
        receive()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.pingEvery, repeating: Self.pingEvery)
        timer.setEventHandler { [weak self] in self?.heartbeat() }
        timer.resume()
        self.timer = timer
    }

    private func heartbeat() {
        guard !finished else { return }
        if Date().timeIntervalSince(lastHeard) > Self.silence { return finish(.closed(code: nil)) }
        let ping = NWProtocolWebSocket.Metadata(opcode: .ping)
        ping.setPongHandler(queue) { [weak self] error in
            if error == nil { self?.lastHeard = Date() }
        }
        connection.send(content: Data(), contentContext: .init(identifier: "ping", metadata: [ping]), isComplete: true, completion: .idempotent)
    }

    private func receive() {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, !self.finished else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            // A close frame can arrive together with the error that ends the socket; its code
            // (4400 update, 4401 signed out) is the part that matters, so it is read first.
            if let metadata, metadata.opcode == .close {
                let code: Int
                switch metadata.closeCode {
                case .protocolCode(let defined): code = Int(defined.rawValue)
                case .applicationCode(let value), .privateCode(let value): code = Int(value)
                @unknown default: code = 1006
                }
                return self.finish(.closed(code: code))
            }
            guard error == nil, let metadata else { return self.endedWithoutCode() }
            self.lastHeard = Date()
            if metadata.opcode == .text || metadata.opcode == .binary, let data { self.feed.yield(.frame(data)) }
            self.receive()
        }
    }

    /// The socket ended with no close frame seen yet. One may still be waiting to be delivered,
    /// so the ending is reported a moment later unless a close code arrives first.
    private func endedWithoutCode() {
        queue.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.finish(.closed(code: nil)) }
    }

    /// Always on `queue`. Emits the ending once and releases the connection.
    private func finish(_ event: SocketEvent?) {
        guard !finished else { return }
        finished = true
        timer?.cancel()
        timer = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        if let event { feed.yield(event) }
        feed.finish()
    }

    func send(_ frame: Data) async throws {
        let text = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "frame", metadata: [text])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: frame, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }

    /// Closed from this side: nothing more is reported.
    func close() {
        queue.async { self.finish(nil) }
    }
}
