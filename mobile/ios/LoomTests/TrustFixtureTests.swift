import CryptoKit
import XCTest
@testable import Loom

/// The shared fixture must verify, and every forged or stale variant of it must not.
final class TrustFixtureTests: XCTestCase {
    private var fixture: TrustFixture!
    private var lookups: FixtureLookups!

    override func setUpWithError() throws {
        fixture = try TrustFixture.load()
        lookups = FixtureLookups(fixture)
    }

    private func signIn(
        reply: Data? = nil,
        email: String? = nil,
        nonce: String? = nil,
        host: String? = nil,
        now: Int64? = nil
    ) async throws -> String {
        try await lookups.checks(now: now ?? fixture.now).verifySignIn(
            host: host ?? fixture.host,
            proofReply: reply ?? fixture.proofReply(),
            expectedEmail: email ?? fixture.expectedEmail,
            nonce: nonce ?? fixture.nonce
        )
    }

    private func transport(reply: Data? = nil, domain: String? = nil, host: String? = nil, now: Int64? = nil) async throws -> TransportProof {
        try await lookups.checks(now: now ?? fixture.now).verifyTransport(
            host: host ?? fixture.host,
            trustDomain: domain ?? fixture.domain,
            proofReply: reply ?? fixture.transportReply()
        )
    }

    // MARK: Sign-in evidence

    func testAuthenticSignInYieldsTheWorkspaceDomain() async throws {
        let domain = try await signIn()
        XCTAssertEqual(domain, "example.com")
    }

    func testEvidenceIsFetchedOnlyFromGoogleAndTheFixedResolver() async throws {
        _ = try await signIn()
        XCTAssertEqual(
            lookups.requested.map(\.absoluteString),
            [
                "https://www.googleapis.com/oauth2/v3/certs",
                "https://cloudflare-dns.com/dns-query?name=_loom.example.com&type=TXT"
            ]
        )
    }

    func testTypedEmailIsComparedWithoutCaseOrSurroundingSpace() async throws {
        let domain = try await signIn(email: "  Developer@Example.COM ")
        XCTAssertEqual(domain, fixture.domain)
    }

    func testAnotherEmailOrAliasIsRefused() async {
        for email in ["someone@example.com", "developer+alias@example.com", "developer@example.org", ""] {
            await XCTAssertThrowsAsync(try await signIn(email: email), email)
        }
    }

    func testAnotherNonceIsRefused() async {
        await XCTAssertThrowsAsync(try await signIn(nonce: "another-attempt-nonce-0123456789abcdef0123456"))
        await XCTAssertThrowsAsync(try await signIn(nonce: ""))
    }

    func testTamperedGoogleTokenIsRefused() async {
        var flipped = Array(fixture.idToken)
        let last = flipped.count - 5
        flipped[last] = flipped[last] == "A" ? "B" : "A"
        let forgeries: [(String, String)] = [
            ("signature byte", String(flipped)),
            ("claims edited", fixture.token(claims: { $0["email"] = "attacker@example.com" })),
            ("alg none", fixture.token(header: { $0["alg"] = "none" })),
            ("alg HS256", fixture.token(header: { $0["alg"] = "HS256" })),
            ("unknown kid", fixture.token(header: { $0["kid"] = "another-key" })),
            ("two segments", fixture.idToken.split(separator: ".").prefix(2).joined(separator: ".")),
            ("oversized", fixture.idToken + String(repeating: "A", count: 40_000))
        ]
        for (name, token) in forgeries {
            await XCTAssertThrowsAsync(try await signIn(reply: fixture.proofReply(idToken: token)), name)
        }
        // Editing the claims and then presenting the attacker's own email must not help.
        await XCTAssertThrowsAsync(
            try await signIn(
                reply: fixture.proofReply(idToken: fixture.token(claims: { $0["email"] = "attacker@example.com" })),
                email: "attacker@example.com"
            )
        )
    }

    func testGoogleKeyMustBeThePublishedRS256Key() async {
        var keys = fixture.jwks
        var key = (keys["keys"] as! [[String: Any]])[0]
        key["alg"] = "RS512"
        keys["keys"] = [key]
        lookups.jwks = TrustFixture.data(keys)
        await XCTAssertThrowsAsync(try await signIn(), "wrong alg")
        lookups.jwks = TrustFixture.data(["keys": []])
        await XCTAssertThrowsAsync(try await signIn(), "no keys")
        lookups.jwks = Data("not json".utf8)
        await XCTAssertThrowsAsync(try await signIn(), "invalid reply")
    }

    func testExpiredOrPostDatedIdentityIsRefused() async throws {
        // exp is now + 300 s, iat is now - 10 s.
        _ = try await signIn(now: fixture.now + 299_000)
        await XCTAssertThrowsAsync(try await signIn(now: fixture.now + 300_000), "exactly at exp")
        await XCTAssertThrowsAsync(try await signIn(now: fixture.now + 3_600_000), "long expired")
        _ = try await signIn(now: fixture.now - 70_000)
        await XCTAssertThrowsAsync(try await signIn(now: fixture.now - 71_000), "issued more than 60 s ahead")
    }

    func testHostProofTampering() async {
        var signature = Array(fixture.hostProof["signature"] as! String)
        signature[3] = signature[3] == "A" ? "B" : "A"
        let key = fixture.hostProof["public_key"] as! String
        let edits: [(String, [String: Any])] = [
            ("signature", fixture.hostProof.merging(["signature": String(signature)]) { $1 }),
            ("names another host", fixture.hostProof.merging(["host": "evil.example.com"]) { $1 }),
            ("unpadded key", fixture.hostProof.merging(["public_key": String(key.dropLast())]) { $1 }),
            ("key with whitespace", fixture.hostProof.merging(["public_key": key + "\n"]) { $1 }),
            ("not a key", fixture.hostProof.merging(["public_key": "AAAA"]) { $1 }),
            ("missing signature", fixture.hostProof.filter { $0.key != "signature" })
        ]
        for (name, proof) in edits {
            await XCTAssertThrowsAsync(try await signIn(reply: fixture.proofReply(hostProof: proof)), name)
        }
        await XCTAssertThrowsAsync(try await signIn(reply: TrustFixture.data(["id_token": fixture.idToken])), "no proof")
        // A proof signed for this host is worthless when we connected somewhere else.
        await XCTAssertThrowsAsync(try await signIn(host: "other.example.com"), "connected host differs")
    }

    func testDNSRecordMustListExactlyThisHostAndKey() async throws {
        let record = "loom-host=loom.example.com; key=u9IUMxX4AAQrzQ0H+7gwninjV8NpdHdgCAAxHr71U/M="
        let refused: [(String, Data)] = [
            ("resolver failure status", TrustFixture.data(["Status": 2, "Answer": fixture.dns["Answer"]!])),
            ("no answers", TrustFixture.data(["Status": 0])),
            ("CNAME instead of TXT", fixture.dnsReply { $0["type"] = 5 }),
            ("another record name", fixture.dnsReply { $0["name"] = "_loom.evil.example.com." }),
            ("parent record name", fixture.dnsReply { $0["name"] = "example.com." }),
            ("host suffix", fixture.dnsReply { $0["data"] = "\"loom-host=loom.example.com.evil.net; key=u9IUMxX4AAQrzQ0H+7gwninjV8NpdHdgCAAxHr71U/M=\"" }),
            ("another key", fixture.dnsReply { $0["data"] = "\"loom-host=loom.example.com; key=AAAAMxX4AAQrzQ0H+7gwninjV8NpdHdgCAAxHr71U/M=\"" }),
            ("trailing text", fixture.dnsReply { $0["data"] = "\"\(record); extra=1\"" }),
            ("unquoted", fixture.dnsReply { $0["data"] = record }),
            ("escaped chunk", fixture.dnsReply { $0["data"] = "\"loom-host=loom.example.com;\\032key=u9IUMxX4AAQrzQ0H+7gwninjV8NpdHdgCAAxHr71U/M=\"" }),
            ("not JSON", Data("<html>".utf8))
        ]
        for (name, reply) in refused {
            lookups.dns = reply
            await XCTAssertThrowsAsync(try await signIn(), name)
        }
        // Resolvers may split a TXT value into chunks and vary the case of the owner name.
        let half = record.index(record.startIndex, offsetBy: 30)
        lookups.dns = fixture.dnsReply {
            $0["name"] = "_LOOM.Example.com"
            $0["data"] = "\"\(record[..<half])\" \"\(record[half...])\""
        }
        let domain = try await signIn()
        XCTAssertEqual(domain, fixture.domain)
    }

    // MARK: Transport binding

    func testAuthenticTransportProofBindsTheSignedTLSKey() async throws {
        let proof = try await transport()
        XCTAssertEqual(proof.tlsFingerprint, "//////////////////////////////////////////8=")
        XCTAssertTrue(proof.tlsFingerprint.contains("/"), "the fixture exercises unescaped slashes in signed JSON")
        XCTAssertEqual(proof.expiresAt, 1_800_000_060_000)
        XCTAssertEqual(lookups.requested.map(\.absoluteString), ["https://cloudflare-dns.com/dns-query?name=_loom.example.com&type=TXT"])
    }

    func testTransportProofFreshness() async throws {
        _ = try await transport(now: 1_800_000_059_999)
        await XCTAssertThrowsAsync(try await transport(now: 1_800_000_060_000), "expires_at is exclusive")
        await XCTAssertThrowsAsync(try await transport(now: 1_800_000_900_000), "long expired")
        // issued_at may lead the device clock by at most a minute.
        _ = try await transport(now: 1_799_999_939_000)
        await XCTAssertThrowsAsync(try await transport(now: 1_799_999_938_999), "issued in the future")
    }

    func testTransportProofTampering() async {
        let edits: [(String, Data)] = [
            ("another TLS key", fixture.transportReply { $0["tls_fingerprint"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }),
            ("non-canonical fingerprint", fixture.transportReply { $0["tls_fingerprint"] = "//////////////////////////////////////////9=" }),
            ("another host", fixture.transportReply { $0["host"] = "evil.example.com" }),
            ("extended lifetime", fixture.transportReply { $0["expires_at"] = 1_800_000_600_000 as Int64 }),
            ("lifetime over 15 minutes", fixture.transportReply { $0["expires_at"] = 1_800_000_999_000 as Int64 }),
            ("inverted interval", fixture.transportReply { $0["issued_at"] = 1_800_000_070_000 as Int64 }),
            ("fractional time", fixture.transportReply { $0["issued_at"] = 1_799_999_999_000.5 }),
            ("text time", fixture.transportReply { $0["expires_at"] = "1800000060000" }),
            ("truncated signature", fixture.transportReply { $0["signature"] = "J76SEURDwKzLsbZCxSTjNN4/YQMbVSGzCicLL4UyXCQ=" }),
            ("not an object", Data("[]".utf8)),
            ("error reply", Data("{\"error\":\"Host verification is not ready\"}".utf8))
        ]
        for (name, reply) in edits {
            await XCTAssertThrowsAsync(try await transport(reply: reply), name)
        }
        await XCTAssertThrowsAsync(try await transport(host: "other.example.com"), "proof replayed on another host")
    }

    func testTransportKeyMustBeAnchoredInTheSavedDomain() async {
        lookups.dns = fixture.dnsReply { $0["data"] = "\"loom-host=loom.example.com; key=AAAAMxX4AAQrzQ0H+7gwninjV8NpdHdgCAAxHr71U/M=\"" }
        await XCTAssertThrowsAsync(try await transport(), "DNS lists another key")
        lookups.dns = fixture.dnsReply()
        // The resolver's answer is for example.com; a different saved domain must not accept it.
        await XCTAssertThrowsAsync(try await transport(domain: "example.org"), "another trust domain")
        await XCTAssertThrowsAsync(try await transport(domain: "not a domain"), "invalid trust domain")
    }

    func testSignedPayloadsAreByteExact() {
        XCTAssertEqual(
            TrustVerifier.hostProofPayload(host: "loom.example.com", nonce: "abc-_123"),
            #"["loom.host-proof.v1","loom.example.com","abc-_123"]"#
        )
        XCTAssertEqual(
            TrustVerifier.transportProofPayload(
                host: "loom.example.com",
                tlsFingerprint: "a/b+c=",
                issuedAt: 1_799_999_999_000,
                expiresAt: 1_800_000_060_000
            ),
            #"["loom.transport-proof.v1","loom.example.com","a/b+c=",1799999999000,1800000060000]"#
        )
        // Anything a JSON encoder could escape differently is refused rather than guessed at.
        XCTAssertNil(TrustVerifier.hostProofPayload(host: "loom.example.com", nonce: "quote\"inside"))
        XCTAssertNil(TrustVerifier.hostProofPayload(host: "loom.example.com\\", nonce: "abc"))
    }
}
