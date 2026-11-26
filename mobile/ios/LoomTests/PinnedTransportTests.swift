import CryptoKit
import Network
import XCTest
@testable import Loom

/// Real TLS against a loopback server: the credential must not leave before the pin holds.
final class PinnedTransportTests: XCTestCase {
    private var pki: TestPKI!
    private var leaf: TestPKI.Leaf!
    private var server: RawServer!
    private let tokenReply = #"{"access_token":"loom_at_1","refresh_token":"loom_rt_1","expires_in":3600}"#
    private let fields = [("grant_type", "authorization_code"), ("code", "loom_code_1"), ("code_verifier", "verifier-secret-value")]

    override func setUpWithError() throws {
        pki = try TestPKI()
        leaf = try pki.leaf()
        let reply = tokenReply
        server = try RawServer(identity: leaf.identity) { request in
            RawServer.requestComplete(request) ? RawServer.http("200 OK", headers: ["Content-Type: application/json"], body: reply) : nil
        }
    }

    private func proof(fingerprint: String? = nil, expiresIn: Int64 = 60_000) -> TransportProof {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return TransportProof(
            host: "localhost",
            publicKey: "",
            tlsFingerprint: fingerprint ?? leaf.spkiFingerprint,
            issuedAt: now - 1000,
            expiresAt: now + expiresIn,
            signature: ""
        )
    }

    private func transport(
        proof: @escaping () async throws -> TransportProof,
        anchors: [SecCertificate]? = nil,
        port: UInt16? = nil,
        now: (() -> Int64)? = nil
    ) -> PinnedTransport {
        let transport = PinnedTransport(
            origin: HostOrigin(testHost: "localhost", port: Int(port ?? server.port)),
            proof: proof,
            now: now ?? { Int64(Date().timeIntervalSince1970 * 1000) }
        )
        transport.testAnchors = anchors ?? [pki.authority]
        return transport
    }

    private func settle() async { try? await Task.sleep(nanoseconds: 300_000_000) }

    // MARK: SPKI

    func testLeafFingerprintIsTheHashOfTheWholeSubjectPublicKeyInfo() throws {
        for algorithm in [TestPKI.Algorithm.p256, .rsa2048] {
            let leaf = try pki.leaf(algorithm: algorithm)
            let der = SecCertificateCopyData(leaf.certificate) as Data
            let spki = try XCTUnwrap(SPKI.subjectPublicKeyInfo(certificateDER: der), "\(algorithm)")
            XCTAssertEqual(Data(SHA256.hash(data: spki)).base64EncodedString(), leaf.spkiFingerprint, "\(algorithm)")
            // The raw key Security hands back is not the SPKI and must not be what is hashed.
            let raw = SecKeyCopyExternalRepresentation(SecCertificateCopyKey(leaf.certificate)!, nil)! as Data
            XCTAssertNotEqual(Data(SHA256.hash(data: raw)).base64EncodedString(), leaf.spkiFingerprint)
            XCTAssertTrue(spki.count > raw.count && spki.suffix(raw.count) == raw)
        }
    }

    func testMalformedCertificatesHaveNoFingerprint() throws {
        let der = SecCertificateCopyData(leaf.certificate) as Data
        XCTAssertNil(SPKI.subjectPublicKeyInfo(certificateDER: Data()))
        XCTAssertNil(SPKI.subjectPublicKeyInfo(certificateDER: Data([0x30, 0x03, 0x02, 0x01, 0x01])))
        XCTAssertNil(SPKI.subjectPublicKeyInfo(certificateDER: der.prefix(der.count / 3)))
        XCTAssertNil(SPKI.subjectPublicKeyInfo(certificateDER: der + Data([0x00])), "trailing bytes")
        var long = der
        long[1] = 0x84
        XCTAssertNil(SPKI.subjectPublicKeyInfo(certificateDER: long), "length beyond the data")
    }

    // MARK: Credential posts

    func testAuthorizedKeyCarriesTheCredentialPost() async throws {
        let transport = transport(proof: { self.proof() })
        let reply = try await transport.post(path: "/auth/token", fields: fields)
        XCTAssertEqual(reply.status, 200)
        XCTAssertEqual(String(decoding: reply.body, as: UTF8.self), tokenReply)
        let request = String(decoding: server.received[0], as: UTF8.self)
        XCTAssertTrue(request.hasPrefix("POST /auth/token HTTP/1.1\r\n"), request)
        XCTAssertTrue(request.contains("\r\nHost: localhost:\(server.port)\r\n"), request)
        XCTAssertTrue(request.lowercased().contains("content-type: application/x-www-form-urlencoded"))
        XCTAssertTrue(request.hasSuffix("\r\n\r\ngrant_type=authorization_code&code=loom_code_1&code_verifier=verifier-secret-value"), request)
    }

    func testAnotherTLSKeyReceivesNoBytesAtAll() async throws {
        let other = try pki.leaf()
        let transport = transport(proof: { self.proof(fingerprint: other.spkiFingerprint) })
        await XCTAssertThrowsAsync(try await transport.post(path: "/auth/token", fields: fields))
        await settle()
        XCTAssertEqual(server.applicationBytes, 0, "the verifier must not leave before the pin holds")
        XCTAssertEqual(server.completedHandshakes, 0)
    }

    func testAnEarlierGoodConnectionGrantsNothingToTheNext() async throws {
        // Two authorized posts first: each must be a full handshake the pin sees.
        let good = transport(proof: { self.proof() })
        _ = try await good.post(path: "/auth/token", fields: fields)
        _ = try await good.post(path: "/auth/token", fields: fields)
        XCTAssertEqual(server.received.count, 2)
        let before = server.applicationBytes

        // The signed binding now names another key. A resumed session would skip the check.
        let other = try pki.leaf()
        let stale = transport(proof: { self.proof(fingerprint: other.spkiFingerprint) })
        await XCTAssertThrowsAsync(try await stale.post(path: "/auth/token", fields: fields))
        await settle()
        XCTAssertEqual(server.applicationBytes, before)
    }

    func testEveryPostFetchesAFreshProof() async throws {
        let asked = Locked(0)
        let transport = transport(proof: {
            asked.update { $0 += 1 }
            return self.proof()
        })
        _ = try await transport.post(path: "/auth/token", fields: fields)
        _ = try await transport.post(path: "/auth/revoke", fields: [("token", "loom_rt_1")])
        XCTAssertEqual(asked.value, 2)
    }

    func testProofThatExpiresBeforeTheHandshakeIsRefused() async throws {
        let issued = proof(expiresIn: 60_000)
        // The clock passes expires_at between verifying the proof and shaking hands.
        let transport = transport(proof: { issued }, now: { issued.expiresAt })
        await XCTAssertThrowsAsync(try await transport.post(path: "/auth/token", fields: fields))
        await settle()
        XCTAssertEqual(server.applicationBytes, 0)
    }

    func testUnavailableProofSendsNothing() async throws {
        struct Unavailable: Error {}
        let transport = transport(proof: { throw Unavailable() })
        await XCTAssertThrowsAsync(try await transport.post(path: "/auth/token", fields: fields))
        await settle()
        XCTAssertEqual(server.received.count, 0, "no connection is even opened without a verified proof")
    }

    func testCorrectPinStillNeedsAnOrdinarilyTrustedChain() async throws {
        // The pin matches, but nothing vouches for the certificate: the system roots do not know it.
        let transport = PinnedTransport(
            origin: HostOrigin(testHost: "localhost", port: Int(server.port)),
            proof: { self.proof() }
        )
        await XCTAssertThrowsAsync(try await transport.post(path: "/auth/token", fields: fields))
        await settle()
        XCTAssertEqual(server.applicationBytes, 0)

        let stranger = try TestPKI()
        let wrongAuthority = self.transport(proof: { self.proof() }, anchors: [stranger.authority])
        await XCTAssertThrowsAsync(try await wrongAuthority.post(path: "/auth/token", fields: fields))
        await settle()
        XCTAssertEqual(server.applicationBytes, 0)
    }

    func testCorrectPinStillNeedsTheHostnameToMatch() async throws {
        let elsewhere = try pki.leaf(name: "elsewhere.example.com")
        let reply = tokenReply
        let other = try RawServer(identity: elsewhere.identity) { request in
            RawServer.requestComplete(request) ? RawServer.http("200 OK", body: reply) : nil
        }
        let transport = transport(proof: { self.proof(fingerprint: elsewhere.spkiFingerprint) }, port: other.port)
        await XCTAssertThrowsAsync(try await transport.post(path: "/auth/token", fields: fields))
        await settle()
        XCTAssertEqual(other.applicationBytes, 0)
    }

    func testCredentialPathsCannotLeaveTheRunner() async {
        let transport = transport(proof: { self.proof() })
        for path in ["auth/token", "//evil.example.com/auth/token", "https://evil.example.com/auth/token", "/auth/token\r\nX-Injected: 1", "/auth/token?x=1 HTTP/1.1"] {
            await XCTAssertThrowsAsync(try await transport.post(path: path, fields: fields), path)
        }
        await settle()
        XCTAssertEqual(server.received.count, 0)
    }

    func testOversizedReplyIsRefused() async throws {
        let big = try RawServer(identity: leaf.identity) { request in
            RawServer.requestComplete(request) ? RawServer.http("200 OK", body: String(repeating: "x", count: 70_000)) : nil
        }
        let transport = transport(proof: { self.proof() }, port: big.port)
        await XCTAssertThrowsAsync(try await transport.post(path: "/auth/token", fields: fields))
    }

    // MARK: WebSocket

    func testWebSocketOpensOnlyOnTheAuthorizedKey() async throws {
        let runner = try FakeRunner(identity: leaf.identity)
        defer { runner.stop() }
        let good = transport(proof: { self.proof() }, port: runner.port)
        let socket = try await good.openWebSocket(bearer: "loom_at_1")
        try await socket.send(Data(#"{"type":"hello","protocol":6}"#.utf8))
        var answer: Data?
        for await event in socket.events {
            if case .frame(let frame) = event { answer = frame }
            break
        }
        // The runner granted mobile.v1 because the pinned upgrade asked for it.
        XCTAssertEqual(answer.map { String(decoding: $0, as: UTF8.self) }, #"{"type":"hello","protocol":6,"capabilities":["bots.v1","mobile.v1"]}"#)
        XCTAssertEqual(runner.upgradeRequests.first?["x-loom-capabilities"], "bots.v1,mobile.v1")
        XCTAssertNil(runner.upgradeRequests.first?["origin"])
        socket.close()

        let other = try pki.leaf()
        let wrong = transport(proof: { self.proof(fingerprint: other.spkiFingerprint) }, port: runner.port)
        await XCTAssertThrowsAsync(try await wrong.openWebSocket(bearer: "loom_at_1")) {
            XCTAssertEqual($0 as? SocketOpenError, .unreachable, "an unproven host is not a refusal of the token")
        }
        await settle()
        XCTAssertEqual(runner.frames.count, 1, "nothing was exchanged on a connection without the pin")
    }
}
