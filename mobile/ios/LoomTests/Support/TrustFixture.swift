import Foundation
import XCTest
@testable import Loom

/// The synthetic trust fixture both native apps verify: mobile/contracts/trust-fixture.json.
struct TrustFixture {
    let now: Int64
    let host: String
    let domain: String
    let expectedEmail: String
    let nonce: String
    let idToken: String
    let jwks: [String: Any]
    let hostProof: [String: Any]
    let transportProof: [String: Any]
    let dns: [String: Any]

    static func load() throws -> TrustFixture {
        let url = try XCTUnwrap(
            Bundle(for: TrustFixtureTests.self).url(forResource: "trust-fixture", withExtension: "json"),
            "trust-fixture.json is missing from the test bundle"
        )
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        func field<T>(_ name: String) throws -> T { try XCTUnwrap(raw[name] as? T, "fixture field \(name)") }
        return TrustFixture(
            now: (try field("now") as NSNumber).int64Value,
            host: try field("host"),
            domain: try field("domain"),
            expectedEmail: try field("expectedEmail"),
            nonce: try field("nonce"),
            idToken: try field("idToken"),
            jwks: try field("jwks"),
            hostProof: try field("hostProof"),
            transportProof: try field("transportProof"),
            dns: try field("dns")
        )
    }

    static func data(_ object: Any) -> Data {
        // The fixture's own JSON text is what a server would send; slashes stay unescaped.
        try! JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    }

    /// The body `/auth/proof` answers with.
    func proofReply(idToken: String? = nil, hostProof: [String: Any]? = nil) -> Data {
        Self.data(["id_token": idToken ?? self.idToken, "host_proof": hostProof ?? self.hostProof])
    }

    func dnsReply(_ change: (inout [String: Any]) -> Void = { _ in }) -> Data {
        var answer = (dns["Answer"] as! [[String: Any]])[0]
        change(&answer)
        return Self.data(["Status": dns["Status"]!, "Answer": [answer]])
    }

    func transportReply(_ change: (inout [String: Any]) -> Void = { _ in }) -> Data {
        var proof = transportProof
        change(&proof)
        return Self.data(proof)
    }

    /// Re-encodes one JWT segment after editing it; the signature no longer covers the result.
    func token(header: ((inout [String: Any]) -> Void)? = nil, claims: ((inout [String: Any]) -> Void)? = nil) -> String {
        var parts = idToken.split(separator: ".").map(String.init)
        func edit(_ index: Int, _ change: (inout [String: Any]) -> Void) {
            var object = try! JSONSerialization.jsonObject(with: Base64.urlDecode(parts[index])!) as! [String: Any]
            change(&object)
            parts[index] = Base64.urlEncode(Self.data(object))
        }
        if let header { edit(0, header) }
        if let claims { edit(1, claims) }
        return parts.joined(separator: ".")
    }
}

/// Records what the verifier asks independent services, and answers from the fixture.
final class FixtureLookups: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [URL] = []
    var jwks: Data
    var dns: Data

    init(_ fixture: TrustFixture) {
        jwks = TrustFixture.data(fixture.jwks)
        dns = fixture.dnsReply()
    }

    var requested: [URL] { lock.withLock { seen } }

    func checks(now: Int64) -> TrustChecks {
        TrustChecks(
            fetch: { [self] url, _ in
                lock.withLock { seen.append(url) }
                if url.host == "www.googleapis.com" { return jwks }
                if url.host == "cloudflare-dns.com" { return dns }
                throw URLError(.unsupportedURL)
            },
            now: { now }
        )
    }
}

func XCTAssertThrowsAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ message: String = "",
    file: StaticString = #filePath,
    line: UInt = #line,
    _ check: (Error) -> Void = { _ in }
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error. \(message)", file: file, line: line)
    } catch {
        check(error)
    }
}

/// Polls for a condition other queues produce, instead of sleeping for a fixed time.
func waitUntil(
    _ timeout: TimeInterval = 5,
    message: String = "condition",
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: @escaping () async -> Bool
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    XCTFail("Timed out waiting for \(message)", file: file, line: line)
}
