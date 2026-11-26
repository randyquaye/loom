import CryptoKit
import Foundation
import Security

/// An organization's host, as a person typed it: HTTPS, a real DNS name, nothing else.
struct HostOrigin: Equatable, Sendable {
    let host: String
    let port: Int?

    enum Invalid: LocalizedError {
        case address
        var errorDescription: String? { "Enter your organization's Loom host, such as loom.example.com." }
    }

    private static let shape = try! NSRegularExpression(pattern: #"^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$"#)

    init(_ input: String) throws {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.lowercased().hasPrefix("https://") {
            text.removeFirst("https://".count)
        } else if text.contains("://") {
            throw Invalid.address
        }
        if text.hasSuffix("/") { text.removeLast() }
        let whole = NSRange(text.startIndex..., in: text)
        // No userinfo, path, query, fragment, IP literal or escape can match this shape.
        guard let match = Self.shape.firstMatch(in: text, range: whole), match.range == whole,
              let hostRange = Range(match.range(at: 1), in: text)
        else { throw Invalid.address }
        let host = text[hostRange].lowercased()
        // A numeric last label is an IP address, which no certificate or DNS record here can vouch for.
        guard TrustVerifier.isDomain(host), host.split(separator: ".").last?.contains(where: \.isLetter) == true else {
            throw Invalid.address
        }
        var port: Int?
        if let portRange = Range(match.range(at: 2), in: text) {
            guard let value = Int(text[portRange]), (1...65535).contains(value) else { throw Invalid.address }
            port = value == 443 ? nil : value
        }
        self.host = host
        self.port = port
    }

    #if DEBUG
    /// Local TLS fixtures only; compiled out of release builds.
    init(testHost: String, port: Int) {
        host = testHost
        self.port = port
    }
    #endif

    var authority: String { port.map { "\(host):\($0)" } ?? host }
    var origin: String { "https://\(authority)" }
    func url(_ path: String) -> URL { URL(string: origin + path)! }
}

enum SignInError: LocalizedError, Equatable {
    /// Not a return to this sign-in: ignored, and the attempt stays usable.
    case invalidCallback
    case refused
    case expired
    case cancelled
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalidCallback: return "The browser did not return a sign-in that Loom started. Try again."
        case .refused: return "This account is not allowed to sign in to this organization."
        case .expired: return "Signing in took too long. Try again."
        case .cancelled: return "Sign-in was cancelled."
        case .unavailable(let reason): return reason
        }
    }
}

func formEncode(_ value: String) -> String {
    let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
}

func formBody(_ fields: [(String, String)]) -> String {
    fields.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&")
}

/// One trip to the browser: its PKCE verifier, state and nonce, and the only callback it accepts.
final class SignInAttempt {
    /// The exact redirect the runner allows for this app. Compared as text, never parsed leniently.
    static let callbackURI = "dev.loom.app.ios:/oauth/callback"
    static let callbackScheme = "dev.loom.app.ios"
    private static let lifetime: TimeInterval = 10 * 60

    let verifier: String
    let state: String
    let nonce: String
    private let startedAt: Date
    private var finished = false

    init(now: Date = Date()) {
        verifier = Self.random()
        state = Self.random()
        nonce = Self.random()
        startedAt = now
    }

    #if DEBUG
    /// Lets tests pair an attempt with the shared fixture's signed nonce.
    init(testNonce: String) {
        verifier = Self.random()
        state = Self.random()
        nonce = testNonce
        startedAt = Date()
    }
    #endif

    /// 32 bytes from the system generator, base64url: 43 characters.
    private static func random() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess, "no secure random bytes")
        return Base64.urlEncode(Data(bytes))
    }

    var challenge: String { Base64.urlEncode(Data(SHA256.hash(data: Data(verifier.utf8)))) }

    /// Where the system browser starts. Carries the challenge; the verifier never leaves this object.
    func startURL(origin: HostOrigin) -> URL {
        let query = formBody([("redirect_uri", Self.callbackURI), ("code_challenge", challenge), ("state", state), ("nonce", nonce)])
        return origin.url("/auth/start?\(query)")
    }

    /// The one-time code from the browser's return, if this is exactly the return this attempt is owed.
    func redeem(callback: String, now: Date = Date()) throws -> String {
        let prefix = Self.callbackURI + "?"
        guard !finished, callback.hasPrefix(prefix), !callback.contains("#") else { throw SignInError.invalidCallback }
        var values: [String: String] = [:]
        for pair in callback.dropFirst(prefix.count).split(separator: "&", omittingEmptySubsequences: false) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            // Exactly code, state and error, each at most once: a token or anything else is not ours.
            guard parts.count == 2,
                  let name = parts[0].replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let value = parts[1].replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  ["code", "state", "error"].contains(name), values[name] == nil
            else { throw SignInError.invalidCallback }
            values[name] = value
        }
        guard let returned = values["state"], sameSecret(returned, state), (values["code"] == nil) != (values["error"] == nil) else {
            throw SignInError.invalidCallback
        }
        if let code = values["code"], code.isEmpty || code.utf8.count > 128 { throw SignInError.invalidCallback }
        // From here the visit is this attempt's own, and it is used up whatever the outcome.
        finished = true
        if now.timeIntervalSince(startedAt) > Self.lifetime { throw SignInError.expired }
        guard let code = values["code"] else { throw SignInError.refused }
        return code
    }
}

struct SignInResult {
    let record: CredentialRecord
    let accessToken: String
    /// Seconds until the access token stops working.
    let expiresIn: Double
}

/// What the runner's token endpoint answered, read the way the desktop reads it.
enum TokenEndpoint {
    struct Tokens {
        let accessToken: String
        let refreshToken: String
        let expiresIn: Double
    }

    /// A refusal (the runner's own answer naming an error) throws `SignInError.refused`.
    /// Anything else that is not a complete success means the runner was never really asked.
    static func request(_ transport: CredentialTransport, fields: [(String, String)]) async throws -> Tokens {
        let reply = try await transport.post(path: "/auth/token", fields: fields)
        let body = (try? JSONSerialization.jsonObject(with: reply.body)) as? [String: Any] ?? [:]
        if [400, 401].contains(reply.status), body["error"] is String { throw SignInError.refused }
        guard (200..<300).contains(reply.status) else {
            throw SignInError.unavailable("The organization's host could not be reached (it answered \(reply.status)).")
        }
        guard let access = body["access_token"] as? String, !access.isEmpty,
              let refresh = body["refresh_token"] as? String, !refresh.isEmpty,
              let expires = (body["expires_in"] as? NSNumber)?.doubleValue, expires.isFinite, expires > 0
        else { throw SignInError.unavailable("The organization's host returned an incomplete sign-in.") }
        return Tokens(accessToken: access, refreshToken: refresh, expiresIn: expires)
    }
}

/// Turns a browser code into tokens. The verifier is released only after Google, DNS and the
/// host proof have all verified, and then only onto a connection pinned to the signed TLS key.
struct SignInExchange {
    /// Unauthenticated POST to the runner: carries the code and callback, never the verifier.
    var postProof: (URL, [(String, String)]) async throws -> HTTPReply
    var checks: TrustChecks
    var pinned: (HostOrigin, _ trustDomain: String) -> CredentialTransport

    func run(origin: HostOrigin, code: String, attempt: SignInAttempt, email: String) async throws -> SignInResult {
        let reply = try await postProof(origin.url("/auth/proof"), [("code", code), ("redirect_uri", SignInAttempt.callbackURI)])
        if [400, 401].contains(reply.status) { throw SignInError.refused }
        guard (200..<300).contains(reply.status) else {
            throw SignInError.unavailable("The organization's host is not ready to verify sign-ins (it answered \(reply.status)).")
        }
        let domain = try await checks.verifySignIn(host: origin.host, proofReply: reply.body, expectedEmail: email, nonce: attempt.nonce)
        let tokens = try await TokenEndpoint.request(
            pinned(origin, domain),
            fields: [
                ("grant_type", "authorization_code"), ("code", code),
                ("redirect_uri", SignInAttempt.callbackURI), ("code_verifier", attempt.verifier)
            ]
        )
        let record = CredentialRecord(
            origin: origin.origin,
            trustDomain: domain,
            email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            refreshToken: tokens.refreshToken
        )
        return SignInResult(record: record, accessToken: tokens.accessToken, expiresIn: tokens.expiresIn)
    }
}
