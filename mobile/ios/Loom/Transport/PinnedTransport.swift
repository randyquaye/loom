import CryptoKit
import Foundation
import Network
import Security

/// Whether a connection's TLS handshake passed the pin. Set from the verify block's queue.
final class HandshakeWitness: @unchecked Sendable {
    private let lock = NSLock()
    private var passed = false
    var verified: Bool { lock.withLock { passed } }
    func pass() { lock.withLock { passed = true } }
}

/// Every credential-bearing connection to a runner: code exchange, renewal, revocation and the
/// WebSocket. Each one fetches a fresh signed proof, opens a brand-new TLS connection with
/// session resumption and tickets disabled, and lets no application byte out until the handshake
/// has passed ordinary CA and hostname validation, the proof is still current, and the leaf
/// certificate's SPKI hash equals the one the organization's key signed.
final class PinnedTransport: CredentialTransport, @unchecked Sendable {
    static let deadline: TimeInterval = 15
    static let maxReplyBytes = 64 * 1024

    let origin: HostOrigin
    private let proof: () async throws -> TransportProof
    private let now: () -> Int64
    #if DEBUG
    /// Roots for local TLS fixtures. Not reachable from settings or the environment, and compiled
    /// out of release builds, where only the system's roots are ever trusted.
    var testAnchors: [SecCertificate]?
    #endif

    /// `proof` must return a transport proof that was just fetched and fully verified.
    init(origin: HostOrigin, proof: @escaping () async throws -> TransportProof, now: @escaping () -> Int64 = WallClock.nowMs) {
        self.origin = origin
        self.proof = proof
        self.now = now
    }

    // MARK: TLS

    /// The whole decision for one handshake. False refuses the connection before anything is sent.
    static func evaluate(trust: SecTrust, host: String, proof: TransportProof, nowMs: Int64, anchors: [SecCertificate]?) -> Bool {
        guard proof.host == host else { return false }
        // Ordinary validation first: a chain to a trusted root, for exactly this hostname.
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess else { return false }
        if let anchors {
            guard SecTrustSetAnchorCertificates(trust, anchors as CFArray) == errSecSuccess,
                  SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
            else { return false }
        }
        guard SecTrustEvaluateWithError(trust, nil) else { return false }
        // The proof may have been verified a moment ago; it must still be current at the handshake.
        guard nowMs < proof.expiresAt else { return false }
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
              let spki = SPKI.subjectPublicKeyInfo(certificateDER: SecCertificateCopyData(leaf) as Data)
        else { return false }
        return sameSecret(Data(SHA256.hash(data: spki)).base64EncodedString(), proof.tlsFingerprint)
    }

    private func tlsOptions(_ proof: TransportProof, _ witness: HandshakeWitness) -> NWProtocolTLS.Options {
        let options = NWProtocolTLS.Options()
        let security = options.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(security, .TLSv12)
        // A resumed session skips certificate verification, and the proof fetch just before this
        // was unpinned. Every credential connection is a full handshake the verify block sees.
        sec_protocol_options_set_tls_resumption_enabled(security, false)
        sec_protocol_options_set_tls_tickets_enabled(security, false)
        sec_protocol_options_set_tls_false_start_enabled(security, false)
        sec_protocol_options_set_tls_server_name(security, origin.host)
        sec_protocol_options_add_tls_application_protocol(security, "http/1.1")
        let host = origin.host
        let now = now
        #if DEBUG
        let anchors = testAnchors
        #else
        let anchors: [SecCertificate]? = nil
        #endif
        sec_protocol_options_set_verify_block(security, { _, trust, complete in
            let reference = sec_trust_copy_ref(trust).takeRetainedValue()
            let passed = PinnedTransport.evaluate(trust: reference, host: host, proof: proof, nowMs: now(), anchors: anchors)
            if passed { witness.pass() }
            complete(passed)
        }, DispatchQueue(label: "dev.loom.app.ios.tls-verify"))
        return options
    }

    private func parameters(_ proof: TransportProof, _ witness: HandshakeWitness) -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = Int(Self.deadline)
        tcp.enableFastOpen = false
        return NWParameters(tls: tlsOptions(proof, witness), tcp: tcp)
    }

    // MARK: Credential posts

    /// A form POST to this runner on a fresh pinned connection that is closed afterwards.
    func post(path: String, fields: [(String, String)]) async throws -> HTTPReply {
        guard path.hasPrefix("/"), !path.hasPrefix("//"),
              path.utf8.allSatisfy({ ($0 >= 0x61 && $0 <= 0x7A) || $0 == UInt8(ascii: "/") || $0 == UInt8(ascii: "-") })
        else { throw TrustFailure("A credential request cannot leave its runner") }
        let proof = try await proof()
        let body = Data(formBody(fields).utf8)
        let head = [
            "POST \(path) HTTP/1.1",
            "Host: \(origin.authority)",
            "Accept: application/json",
            "Content-Type: application/x-www-form-urlencoded",
            "Content-Length: \(body.count)",
            "Connection: close",
            "", ""
        ].joined(separator: "\r\n")
        let connection = NWConnection(
            host: NWEndpoint.Host(origin.host),
            port: NWEndpoint.Port(rawValue: UInt16(origin.port ?? 443))!,
            using: parameters(proof, HandshakeWitness())
        )
        return try await PinnedExchange(connection: connection, request: Data(head.utf8) + body).run()
    }

    // MARK: WebSocket

    /// The runner connection: `/v1/ws` with the bearer token and no Origin, on a pinned handshake.
    func openWebSocket(bearer: String) async throws -> WebSocketChannel {
        let proof: TransportProof
        do {
            proof = try await self.proof()
        } catch {
            // Unproven is not refused: the sign-in stays, and the connection is tried again later.
            throw SocketOpenError.unreachable
        }
        let witness = HandshakeWitness()
        let url = URL(string: "wss://\(origin.authority)/v1/ws")!
        return try await WebSocketChannel.open(url: url, parameters: parameters(proof, witness), bearer: bearer, witness: witness)
    }
}

/// One request and one bounded reply over a connection that sends nothing until TLS is ready.
private final class PinnedExchange: @unchecked Sendable {
    private let connection: NWConnection
    private let request: Data
    private let queue = DispatchQueue(label: "dev.loom.app.ios.pinned-post")
    private var parser = HTTPReplyParser(maxBodyBytes: PinnedTransport.maxReplyBytes)
    private var continuation: CheckedContinuation<HTTPReply, Error>?

    init(connection: NWConnection, request: Data) {
        self.connection = connection
        self.request = request
    }

    func run() async throws -> HTTPReply {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    self.continuation = continuation
                    // `finish` clears this handler, which is what releases the exchange.
                    self.connection.stateUpdateHandler = { state in
                        switch state {
                        case .ready: self.send()
                        // `waiting` would retry on its own; a credential request never does.
                        case .failed, .waiting, .cancelled: self.finish(.failure(TrustFailure.transport))
                        default: break
                        }
                    }
                    self.connection.start(queue: self.queue)
                    self.queue.asyncAfter(deadline: .now() + PinnedTransport.deadline) { self.finish(.failure(HTTPFailure.timedOut)) }
                }
            }
        } onCancel: {
            queue.async { self.finish(.failure(CancellationError())) }
        }
    }

    private func send() {
        connection.send(content: request, completion: .contentProcessed { [weak self] error in
            if error != nil { self?.finish(.failure(TrustFailure.transport)) } else { self?.receive() }
        })
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self, self.continuation != nil else { return }
            do {
                if let data, !data.isEmpty, let reply = try self.parser.feed(data) { return self.finish(.success(reply)) }
                if complete { return self.finish(.success(try self.parser.finish())) }
                if error != nil { return self.finish(.failure(HTTPFailure.malformed)) }
                self.receive()
            } catch {
                self.finish(.failure(error))
            }
        }
    }

    /// Always on `queue`. The first outcome wins and the connection is never reused.
    private func finish(_ result: Result<HTTPReply, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        continuation.resume(with: result)
    }
}
