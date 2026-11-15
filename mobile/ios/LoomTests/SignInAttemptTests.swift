import CryptoKit
import XCTest
@testable import Loom

final class SignInAttemptTests: XCTestCase {
    private let callback = "dev.loom.app.ios:/oauth/callback"

    func testHostAddressAcceptsOnlyAnUnambiguousHTTPSOrigin() throws {
        XCTAssertEqual(try HostOrigin("loom.example.com").origin, "https://loom.example.com")
        XCTAssertEqual(try HostOrigin("  https://Loom.Example.com/ ").origin, "https://loom.example.com")
        XCTAssertEqual(try HostOrigin("https://loom.example.com:8443").origin, "https://loom.example.com:8443")
        XCTAssertEqual(try HostOrigin("loom.example.com").host, "loom.example.com")

        let refused = [
            "", "http://loom.example.com", "ws://loom.example.com", "https://user@loom.example.com",
            "https://user:pw@loom.example.com", "https://loom.example.com/path", "https://loom.example.com?x=1",
            "https://loom.example.com#frag", "https://loom.example.com/#", "https://192.168.1.10", "https://[::1]",
            "localhost", "https://loom", "https://loom.example.com.", "https://loom..example.com",
            "https://-loom.example.com", "https://loom.example.com:0", "https://loom.example.com:99999",
            "https://loom.example.com:", "https://loom.exämple.com", "https://loom.example.com\\@evil.com",
            "https://loom.example.com%2f.evil.com", "https:// loom.example.com", "https://https://loom.example.com",
            "loom.example.com evil.com"
        ]
        for input in refused {
            XCTAssertThrowsError(try HostOrigin(input), "accepted \(input)")
        }
    }

    func testStartAddressCarriesTheChallengeAndNeverTheVerifier() throws {
        let attempt = SignInAttempt()
        let url = attempt.startURL(origin: try HostOrigin("loom.example.com"))
        let parts = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(parts.scheme, "https")
        XCTAssertEqual(parts.host, "loom.example.com")
        XCTAssertEqual(parts.path, "/auth/start")
        let query = Dictionary(uniqueKeysWithValues: (parts.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(Set(query.keys), ["redirect_uri", "code_challenge", "state", "nonce"])
        XCTAssertEqual(query["redirect_uri"], callback)
        XCTAssertEqual(query["state"], attempt.state)
        XCTAssertEqual(query["nonce"], attempt.nonce)
        XCTAssertEqual(query["code_challenge"], Base64.urlEncode(Data(SHA256.hash(data: Data(attempt.verifier.utf8)))))
        XCTAssertFalse(url.absoluteString.contains(attempt.verifier))

        for secret in [attempt.verifier, attempt.state, attempt.nonce] {
            XCTAssertNotNil(secret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression), "32 random bytes, base64url")
        }
        let other = SignInAttempt()
        XCTAssertNotEqual(other.verifier, attempt.verifier)
        XCTAssertNotEqual(other.state, attempt.state)
        XCTAssertNotEqual(other.nonce, attempt.nonce)
    }

    func testMatchingCallbackYieldsItsCodeOnce() throws {
        let attempt = SignInAttempt()
        let returned = "\(callback)?code=loom_code_abc-DEF_123&state=\(attempt.state)"
        XCTAssertEqual(try attempt.redeem(callback: returned), "loom_code_abc-DEF_123")
        XCTAssertThrowsError(try attempt.redeem(callback: returned), "a second completion must be refused") {
            XCTAssertEqual($0 as? SignInError, .invalidCallback)
        }
    }

    /// The test host is the app itself, so this reads the identity it was actually built with.
    func testAppIdentityMatchesTheCallbackTheRunnerAllows() throws {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "dev.loom.app.ios")
        let types = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]])
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertEqual(schemes, ["dev.loom.app.ios"], "exactly one scheme, and no legacy alias")
        XCTAssertEqual(SignInAttempt.callbackScheme, "dev.loom.app.ios")
        XCTAssertEqual(SignInAttempt.callbackURI, callback)
    }

    func testCallbackForAnotherAttemptLeavesThisOneUsable() throws {
        let attempt = SignInAttempt()
        XCTAssertThrowsError(try attempt.redeem(callback: "\(callback)?code=stolen&state=\(SignInAttempt().state)"))
        XCTAssertEqual(try attempt.redeem(callback: "\(callback)?code=mine&state=\(attempt.state)"), "mine")
    }

    func testNearMissCallbacksAreRefused() {
        let attempt = SignInAttempt()
        let state = attempt.state
        let refused = [
            "dev.loom.app.ios://oauth/callback?code=c&state=\(state)",
            "dev.loom.app.ios:oauth/callback?code=c&state=\(state)",
            "DEV.LOOM.APP.IOS:/oauth/callback?code=c&state=\(state)",
            "Dev.Loom.App.iOS:/oauth/callback?code=c&state=\(state)",
            "dev.loom.app.android:/oauth/callback?code=c&state=\(state)",
            "dev.loom.app:/oauth/callback?code=c&state=\(state)",
            "dev.loom.app.ios.evil:/oauth/callback?code=c&state=\(state)",
            "evil.dev.loom.app.ios:/oauth/callback?code=c&state=\(state)",
            "dev.loom.app.ios:/oauth/callback/extra?code=c&state=\(state)",
            "dev.loom.app.ios:/oauth/Callback?code=c&state=\(state)",
            "dev.loom.app.ios:/oauth/%63allback?code=c&state=\(state)",
            "dev%2Eloom.app.ios:/oauth/callback?code=c&state=\(state)",
            "dev.loom.app.ios://user@host/oauth/callback?code=c&state=\(state)",
            // The planning-era identifiers were never deployed: no legacy alias is honored.
            "com.loom.ios:/oauth/callback?code=c&state=\(state)",
            "com.loom.android:/oauth/callback?code=c&state=\(state)",
            "https://loom.example.com/oauth/callback?code=c&state=\(state)",
            "\(callback)?code=c&state=\(state)#fragment",
            "\(callback)#code=c&state=\(state)",
            "\(callback)?code=c&code=d&state=\(state)",
            "\(callback)?code=c&state=\(state)&state=\(state)",
            "\(callback)?code=c",
            "\(callback)?state=\(state)",
            "\(callback)?code=&state=\(state)",
            "\(callback)?code=c&state=\(state)x",
            "\(callback)?code=c&state=\(state.lowercased())",
            "\(callback)?code=c&state=\(state)&access_token=loom_at_x",
            "\(callback)?code=c&state=\(state)&refresh_token=loom_rt_x",
            "\(callback)?code=c&error=access_denied&state=\(state)",
            "\(callback)?code=\(String(repeating: "c", count: 129))&state=\(state)",
            "\(callback)",
            ""
        ]
        for value in refused {
            XCTAssertThrowsError(try attempt.redeem(callback: value), "accepted \(value)") {
                XCTAssertEqual($0 as? SignInError, .invalidCallback, value)
            }
        }
        // None of the refused visits consumed the attempt.
        XCTAssertEqual(try? attempt.redeem(callback: "\(callback)?code=c&state=\(state)"), "c")
    }

    func testRunnerRefusalEndsTheAttempt() {
        let attempt = SignInAttempt()
        XCTAssertThrowsError(try attempt.redeem(callback: "\(callback)?error=access_denied&state=\(attempt.state)")) {
            XCTAssertEqual($0 as? SignInError, .refused)
        }
        XCTAssertThrowsError(try attempt.redeem(callback: "\(callback)?code=c&state=\(attempt.state)"))
    }

    func testStaleAttemptIsRefused() {
        let started = Date(timeIntervalSince1970: 1_800_000_000)
        let attempt = SignInAttempt(now: started)
        let returned = "\(callback)?code=c&state=\(attempt.state)"
        XCTAssertThrowsError(try attempt.redeem(callback: returned, now: started.addingTimeInterval(601))) {
            XCTAssertEqual($0 as? SignInError, .expired)
        }
        XCTAssertThrowsError(try attempt.redeem(callback: returned, now: started.addingTimeInterval(1)), "expiry is final")
    }

    // MARK: Code exchange ordering

    /// The verifier must stay on the device until identity, DNS and host proof have all passed.
    func testVerifierIsWithheldUntilEvidenceVerifies() async throws {
        let fixture = try TrustFixture.load()
        let lookups = FixtureLookups(fixture)
        let attempt = SignInAttempt()
        let pinned = RecordingTransport(replies: [.init(status: 200, body: Data(#"{"access_token":"loom_at_1","refresh_token":"loom_rt_1","expires_in":3600}"#.utf8))])
        var proofFields: [[String: String]] = []
        var pinnedDomains: [String] = []
        let exchange = SignInExchange(
            postProof: { _, fields in
                proofFields.append(Dictionary(uniqueKeysWithValues: fields))
                return HTTPReply(status: 200, body: fixture.proofReply())
            },
            checks: lookups.checks(now: fixture.now),
            pinned: { _, domain in
                pinnedDomains.append(domain)
                return pinned
            }
        )
        let origin = try HostOrigin(fixture.host)

        // The fixture token carries the fixture nonce, not this attempt's: verification fails.
        await XCTAssertThrowsAsync(try await exchange.run(origin: origin, code: "loom_code_1", attempt: attempt, email: fixture.expectedEmail))
        XCTAssertEqual(proofFields, [["code": "loom_code_1", "redirect_uri": "dev.loom.app.ios:/oauth/callback"]])
        XCTAssertTrue(pinnedDomains.isEmpty, "no credential connection may be prepared after failed evidence")
        XCTAssertTrue(pinned.requests.isEmpty)

        // With evidence that does verify, the verifier goes out once, on the pinned transport only.
        let matching = SignInAttempt(testNonce: fixture.nonce)
        let result = try await exchange.run(origin: origin, code: "loom_code_2", attempt: matching, email: fixture.expectedEmail)
        XCTAssertEqual(result.record.trustDomain, "example.com")
        XCTAssertEqual(result.record.origin, "https://loom.example.com")
        XCTAssertEqual(result.record.email, fixture.expectedEmail)
        XCTAssertEqual(result.record.refreshToken, "loom_rt_1")
        XCTAssertEqual(result.accessToken, "loom_at_1")
        XCTAssertEqual(pinnedDomains, ["example.com"])
        XCTAssertEqual(pinned.requests.count, 1)
        XCTAssertEqual(pinned.requests[0].path, "/auth/token")
        XCTAssertEqual(
            pinned.requests[0].fields,
            [
                "grant_type": "authorization_code", "code": "loom_code_2",
                "redirect_uri": "dev.loom.app.ios:/oauth/callback", "code_verifier": matching.verifier
            ]
        )
        XCTAssertFalse(proofFields.contains { $0.values.contains(matching.verifier) || $0.keys.contains("code_verifier") })
    }

    func testRefusedProofOrTokenIsASignInRefusal() async throws {
        let fixture = try TrustFixture.load()
        let lookups = FixtureLookups(fixture)
        let origin = try HostOrigin(fixture.host)
        let attempt = SignInAttempt(testNonce: fixture.nonce)
        let refusedProof = SignInExchange(
            postProof: { _, _ in HTTPReply(status: 400, body: Data(#"{"error":"invalid_grant"}"#.utf8)) },
            checks: lookups.checks(now: fixture.now),
            pinned: { _, _ in XCTFail("unreachable"); return RecordingTransport(replies: []) }
        )
        await XCTAssertThrowsAsync(try await refusedProof.run(origin: origin, code: "c", attempt: attempt, email: fixture.expectedEmail)) {
            XCTAssertEqual($0 as? SignInError, .refused)
        }
        let refusedToken = SignInExchange(
            postProof: { _, _ in HTTPReply(status: 200, body: fixture.proofReply()) },
            checks: lookups.checks(now: fixture.now),
            pinned: { _, _ in
                RecordingTransport(replies: [.init(status: 400, body: Data(#"{"error":"invalid_grant","error_description":"used"}"#.utf8))])
            }
        )
        await XCTAssertThrowsAsync(try await refusedToken.run(origin: origin, code: "c", attempt: attempt, email: fixture.expectedEmail)) {
            XCTAssertEqual($0 as? SignInError, .refused)
        }
    }
}

/// A credential transport that records what it was asked to carry.
final class RecordingTransport: CredentialTransport, @unchecked Sendable {
    struct Request: Equatable {
        let path: String
        let fields: [String: String]
    }

    private let lock = NSLock()
    private var queued: [HTTPReply]
    private var seen: [Request] = []
    /// Held before answering, so tests can overlap callers.
    var delayNanoseconds: UInt64 = 0
    var failure: Error?

    init(replies: [HTTPReply]) { queued = replies }

    var requests: [Request] { lock.withLock { seen } }

    func post(path: String, fields: [(String, String)]) async throws -> HTTPReply {
        lock.withLock { seen.append(Request(path: path, fields: Dictionary(uniqueKeysWithValues: fields))) }
        if delayNanoseconds > 0 { try? await Task.sleep(nanoseconds: delayNanoseconds) }
        if let failure { throw failure }
        return lock.withLock { queued.isEmpty ? HTTPReply(status: 502, body: Data()) : queued.removeFirst() }
    }
}
