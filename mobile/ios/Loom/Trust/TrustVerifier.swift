import CryptoKit
import Foundation
import Security

/// Evidence did not verify. Nothing that depends on it may be sent or saved.
struct TrustFailure: LocalizedError, Equatable {
    let reason: String
    init(_ reason: String) { self.reason = reason }
    var errorDescription: String? { reason }

    static func host(_ reason: String) -> TrustFailure {
        TrustFailure("The organization's host could not be verified: \(reason)")
    }

    static let transport = TrustFailure("The cloud host could not prove its current TLS connection")
}

enum Base64 {
    /// Standard base64 that re-encodes to exactly the same text, optionally of a fixed decoded size.
    static func canonical(_ value: String, bytes: Int? = nil) -> Data? {
        guard value.utf8.count <= 1024, let decoded = Data(base64Encoded: value), decoded.base64EncodedString() == value else { return nil }
        return bytes == nil || decoded.count == bytes ? decoded : nil
    }

    static func isURLSafe(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || byte == 0x2D || byte == 0x5F
        }
    }

    static func urlDecode(_ value: String) -> Data? {
        guard isURLSafe(value) else { return nil }
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        return Data(base64Encoded: text)
    }

    static func urlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

struct HostProof: Equatable {
    let host: String
    /// Ed25519 SubjectPublicKeyInfo, DER, base64.
    let publicKey: String
    let signature: String
}

/// The org key authorizes one TLS leaf key for a short, signed interval.
struct TransportProof: Equatable {
    let host: String
    let publicKey: String
    /// Base64 SHA-256 of the TLS leaf's SubjectPublicKeyInfo.
    let tlsFingerprint: String
    let issuedAt: Int64
    let expiresAt: Int64
    let signature: String
}

/// A Google ID token whose shape and algorithm are acceptable; nothing in it is trusted yet.
struct UnverifiedIdentity {
    let signedText: Data
    let signature: Data
    let keyID: String
    let claims: [String: Any]
}

/// The four checks of the desktop's cloud/host-proof.ts and auth/transport-proof.ts, as pure functions.
enum TrustVerifier {
    static let googleKeys = URL(string: "https://www.googleapis.com/oauth2/v3/certs")!
    static let maxTokenAgeSeconds = 600.0
    static let maxProofLifetimeMs: Int64 = 15 * 60_000
    private static let ed25519Prefix: [UInt8] = [0x30, 0x2A, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65, 0x70, 0x03, 0x21, 0x00]

    static func dnsQuery(domain: String) -> URL {
        URL(string: "https://cloudflare-dns.com/dns-query?name=_loom.\(domain)&type=TXT")!
    }

    /// A lowercase DNS name of at least two labels, as the desktop's DOMAIN pattern accepts.
    static func isDomain(_ value: String) -> Bool {
        guard (1...253).contains(value.utf8.count) else { return false }
        let labels = value.utf8.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
        func alphanumeric(_ byte: UInt8) -> Bool { (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x7A) }
        return labels.count >= 2 && labels.allSatisfy { label in
            guard (1...63).contains(label.count), let first = label.first, let last = label.last else { return false }
            return alphanumeric(first) && alphanumeric(last) && label.allSatisfy { alphanumeric($0) || $0 == UInt8(ascii: "-") }
        }
    }

    // MARK: JSON values

    private static func object(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func isBoolean(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, !isBoolean(number), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }

    /// A JSON integer only: a fraction or an exponent cannot be reproduced in the signed text.
    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, !isBoolean(number), !CFNumberIsFloatType(number) else { return nil }
        let exact = number.int64Value
        return exact > 0 && exact <= 9_007_199_254_740_991 ? exact : nil
    }

    // MARK: Google identity

    static func parseIdentity(_ idToken: String) throws -> UnverifiedIdentity {
        let segments = idToken.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard idToken.utf8.count <= 32768, segments.count == 3, segments.allSatisfy(Base64.isURLSafe),
              let header = Base64.urlDecode(segments[0]).flatMap(object),
              let claims = Base64.urlDecode(segments[1]).flatMap(object),
              let signature = Base64.urlDecode(segments[2])
        else { throw TrustFailure.host("invalid Google token") }
        guard header["alg"] as? String == "RS256", let keyID = header["kid"] as? String else {
            throw TrustFailure.host("invalid Google signing key")
        }
        return UnverifiedIdentity(signedText: Data("\(segments[0]).\(segments[1])".utf8), signature: signature, keyID: keyID, claims: claims)
    }

    /// Returns the Google Workspace domain (`hd`) of an identity that is authentic, current and the typed person's.
    static func verifyIdentity(
        _ identity: UnverifiedIdentity,
        jwks: Data,
        expectedEmail: String,
        nonce: String,
        nowMs: Int64
    ) throws -> String {
        let expected = expectedEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !expected.isEmpty else { throw TrustFailure.host("enter your work email before signing in") }
        let published = (object(jwks)?["keys"] as? [[String: Any]])?.first {
            $0["kid"] as? String == identity.keyID && $0["kty"] as? String == "RSA" && $0["alg"] as? String == "RS256"
        }
        guard let published else { throw TrustFailure.host("Google did not publish this signing key") }
        guard let key = rsaKey(published),
              SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, identity.signedText as CFData, identity.signature as CFData, nil)
        else { throw TrustFailure.host("invalid Google signature") }

        let claims = identity.claims
        let now = Double(nowMs / 1000)
        let issuer = claims["iss"] as? String
        let verified = (claims["email_verified"] as? NSNumber).map { isBoolean($0) && $0.boolValue } ?? (claims["email_verified"] as? String == "true")
        guard issuer == "https://accounts.google.com" || issuer == "accounts.google.com",
              let expires = number(claims["exp"]), expires > now,
              let issued = number(claims["iat"]), issued <= now + 60, now - issued <= maxTokenAgeSeconds,
              !nonce.isEmpty, claims["nonce"] as? String == nonce,
              verified,
              let email = claims["email"] as? String, email.lowercased() == expected,
              let subject = claims["sub"] as? String, !subject.isEmpty
        else { throw TrustFailure.host("Google identity is missing, expired, or belongs to another sign-in") }
        let domain = (claims["hd"] as? String)?.lowercased() ?? ""
        guard isDomain(domain) else { throw TrustFailure.host("a verified Google Workspace account is required") }
        return domain
    }

    /// Security wants PKCS#1 DER; a JWK carries the bare modulus and exponent.
    private static func rsaKey(_ jwk: [String: Any]) -> SecKey? {
        guard let modulus = (jwk["n"] as? String).flatMap(Base64.urlDecode).map({ Array($0.drop { $0 == 0 }) }),
              let exponent = (jwk["e"] as? String).flatMap(Base64.urlDecode).map({ Array($0.drop { $0 == 0 }) }),
              modulus.count >= 256, modulus.count <= 1024, !exponent.isEmpty, exponent.count <= 8
        else { return nil }
        func length(_ count: Int) -> [UInt8] {
            count < 0x80 ? [UInt8(count)] : count <= 0xFF ? [0x81, UInt8(count)] : [0x82, UInt8(count >> 8), UInt8(count & 0xFF)]
        }
        func integer(_ bytes: [UInt8]) -> [UInt8] {
            let content = bytes[0] & 0x80 != 0 ? [0x00] + bytes : bytes
            return [0x02] + length(content.count) + content
        }
        let body = integer(modulus) + integer(exponent)
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic, kSecAttrKeySizeInBits: modulus.count * 8
        ]
        return SecKeyCreateWithData(Data([0x30] + length(body.count) + body) as CFData, attributes as CFDictionary, nil)
    }

    // MARK: Domain authorization

    /// DNS JSON gives a TXT value as quoted character strings. Any escape is refused outright.
    private static func txtValue(_ data: String) -> String? {
        var chunks: [UInt8] = []
        var found = false
        var bytes = Array(data.utf8)[...]
        while let byte = bytes.first {
            if byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D {
                bytes = bytes.dropFirst()
                continue
            }
            guard byte == 0x22, let end = bytes.dropFirst().firstIndex(of: 0x22) else { return nil }
            let chunk = bytes[(bytes.startIndex + 1)..<end]
            if chunk.contains(0x5C) { return nil }
            chunks.append(contentsOf: chunk)
            found = true
            bytes = bytes[(end + 1)...]
        }
        return found ? String(bytes: chunks, encoding: .utf8) : nil
    }

    private static let record = try! NSRegularExpression(pattern: #"^loom-host=([^;\s]+);\s*key=([A-Za-z0-9+/]{43}=)$"#)

    /// The org's Ed25519 key, accepted only if `_loom.<domain>` lists exactly this host and this key.
    static func verifyDomainHostKey(domain: String, host: String, publicKey: String, dnsReply: Data) throws -> Curve25519.Signing.PublicKey {
        guard isDomain(domain), publicKey.utf8.count <= 512, let der = Base64.canonical(publicKey, bytes: 44),
              Array(der.prefix(ed25519Prefix.count)) == ed25519Prefix,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32))
        else { throw TrustFailure.host("invalid Workspace domain or runner key") }
        let fingerprint = Data(SHA256.hash(data: der)).base64EncodedString()
        let name = "_loom.\(domain)"
        let reply = object(dnsReply)
        let answered = (reply?["Status"] as? NSNumber).map { !isBoolean($0) && !CFNumberIsFloatType($0) && $0.intValue == 0 } ?? false
        let listed = answered && ((reply?["Answer"] as? [Any]) ?? []).contains { item in
            guard let answer = item as? [String: Any],
                  let type = answer["type"] as? NSNumber, !isBoolean(type), type.doubleValue == 16,
                  var owner = (answer["name"] as? String)?.lowercased(),
                  let data = answer["data"] as? String
            else { return false }
            if owner.hasSuffix(".") { owner.removeLast() }
            guard owner == name, let text = txtValue(data)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
            let whole = NSRange(text.startIndex..., in: text)
            guard let match = record.firstMatch(in: text, range: whole), match.range == whole,
                  let listedHost = Range(match.range(at: 1), in: text), let listedKey = Range(match.range(at: 2), in: text)
            else { return false }
            return text[listedHost].lowercased() == host && text[listedKey] == fingerprint
        }
        guard listed else { throw TrustFailure.host("\(name) does not list this host and signing key") }
        return key
    }

    // MARK: Signed payloads

    /// Signed text is assembled by hand: a JSON encoder may escape `/`, and fingerprints contain it.
    /// Only characters JSON never escapes are allowed through.
    private static func literal(_ value: String) -> String? {
        let safe = !value.isEmpty && value.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || "-._~+/=:".utf8.contains(byte)
        }
        return safe ? "\"\(value)\"" : nil
    }

    static func hostProofPayload(host: String, nonce: String) -> String? {
        guard let host = literal(host), let nonce = literal(nonce) else { return nil }
        return "[\"loom.host-proof.v1\",\(host),\(nonce)]"
    }

    static func transportProofPayload(host: String, tlsFingerprint: String, issuedAt: Int64, expiresAt: Int64) -> String? {
        guard let host = literal(host), let fingerprint = literal(tlsFingerprint) else { return nil }
        return "[\"loom.transport-proof.v1\",\(host),\(fingerprint),\(issuedAt),\(expiresAt)]"
    }

    static func parseHostProof(_ value: Any?) -> HostProof? {
        guard let object = value as? [String: Any], let host = object["host"] as? String,
              let publicKey = object["public_key"] as? String, let signature = object["signature"] as? String
        else { return nil }
        return HostProof(host: host, publicKey: publicKey, signature: signature)
    }

    /// The runner holds the listed key: it signed this host and this sign-in's nonce.
    static func verifyHostProof(_ proof: HostProof, host: String, nonce: String, key: Curve25519.Signing.PublicKey) throws {
        guard proof.host == host,
              let signature = Base64.canonical(proof.signature, bytes: 64),
              let payload = hostProofPayload(host: host, nonce: nonce),
              key.isValidSignature(signature, for: Data(payload.utf8))
        else { throw TrustFailure.host("the runner could not prove it holds the listed signing key") }
    }

    /// Syntax, freshness and self-signature. The caller must still anchor the key in the org's domain.
    static func parseTransportProof(_ reply: Data, host: String, nowMs: Int64) throws -> TransportProof {
        guard let value = object(reply), value["host"] as? String == host,
              let issued = integer(value["issued_at"]), let expires = integer(value["expires_at"]),
              expires > issued, expires - issued <= maxProofLifetimeMs, issued <= nowMs + 60_000, expires > nowMs,
              let fingerprint = value["tls_fingerprint"] as? String, Base64.canonical(fingerprint, bytes: 32) != nil,
              let publicKey = value["public_key"] as? String, let der = Base64.canonical(publicKey, bytes: 44),
              Array(der.prefix(ed25519Prefix.count)) == ed25519Prefix,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32)),
              let encoded = value["signature"] as? String, let signature = Base64.canonical(encoded, bytes: 64),
              let payload = transportProofPayload(host: host, tlsFingerprint: fingerprint, issuedAt: issued, expiresAt: expires),
              key.isValidSignature(signature, for: Data(payload.utf8))
        else { throw TrustFailure.transport }
        return TransportProof(host: host, publicKey: publicKey, tlsFingerprint: fingerprint, issuedAt: issued, expiresAt: expires, signature: encoded)
    }
}

/// The verifications that need independent lookups: Google's keys and the fixed DNS resolver.
struct TrustChecks {
    /// Fetches public evidence over ordinary TLS: no redirects, bounded size and time.
    var fetch: (URL, _ accept: String) async throws -> Data
    var now: () -> Int64

    /// Checks what `/auth/proof` returned and yields the Workspace domain to trust from now on.
    func verifySignIn(host: String, proofReply: Data, expectedEmail: String, nonce: String) async throws -> String {
        do {
            guard let reply = (try? JSONSerialization.jsonObject(with: proofReply)) as? [String: Any],
                  let idToken = reply["id_token"] as? String, let proof = TrustVerifier.parseHostProof(reply["host_proof"])
            else { throw TrustFailure.host("the runner did not return its sign-in proof") }
            let identity = try TrustVerifier.parseIdentity(idToken)
            let keys = try await fetch(TrustVerifier.googleKeys, "application/json")
            let domain = try TrustVerifier.verifyIdentity(identity, jwks: keys, expectedEmail: expectedEmail, nonce: nonce, nowMs: now())
            guard proof.host == host else { throw TrustFailure.host("the runner proof names another host") }
            let dns = try await fetch(TrustVerifier.dnsQuery(domain: domain), "application/dns-json")
            let key = try TrustVerifier.verifyDomainHostKey(domain: domain, host: host, publicKey: proof.publicKey, dnsReply: dns)
            try TrustVerifier.verifyHostProof(proof, host: host, nonce: nonce, key: key)
            return domain
        } catch let failure as TrustFailure {
            throw failure
        } catch {
            throw TrustFailure.host("independent verification is unavailable; try again shortly")
        }
    }

    /// Checks what `/auth/transport` returned against the saved domain, before any credential connection.
    func verifyTransport(host: String, trustDomain: String, proofReply: Data) async throws -> TransportProof {
        do {
            let proof = try TrustVerifier.parseTransportProof(proofReply, host: host, nowMs: now())
            guard TrustVerifier.isDomain(trustDomain) else { throw TrustFailure.transport }
            let dns = try await fetch(TrustVerifier.dnsQuery(domain: trustDomain), "application/dns-json")
            _ = try TrustVerifier.verifyDomainHostKey(domain: trustDomain, host: host, publicKey: proof.publicKey, dnsReply: dns)
            return proof
        } catch {
            throw TrustFailure.transport
        }
    }
}

enum WallClock {
    static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

/// Compares two secrets without stopping at the first difference.
func sameSecret(_ left: String, _ right: String) -> Bool {
    let a = Array(left.utf8)
    let b = Array(right.utf8)
    guard a.count == b.count else { return false }
    return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}
