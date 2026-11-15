import CryptoKit
import Foundation
import Security
import XCTest

/// Throwaway TLS identities made at test time. Keys live in the simulator keychain for the
/// length of one test and are deleted afterwards; nothing here is ever written to the repository.
final class TestPKI {
    enum Algorithm {
        case p256
        case rsa2048
    }

    struct Leaf {
        let certificate: SecCertificate
        let identity: SecIdentity
        /// Base64 SHA-256 of the leaf's SubjectPublicKeyInfo, built independently of the app's parser.
        let spkiFingerprint: String
    }

    let authority: SecCertificate
    private let authorityKey: SecKey
    private let tag = "dev.loom.app.ios.tests.\(UUID().uuidString)"
    private var labels: [String] = []

    init() throws {
        authorityKey = try Self.makeKey(.p256, tag: nil)
        let der = try Self.certificate(
            subject: "Loom Test Authority",
            issuer: "Loom Test Authority",
            subjectKey: authorityKey,
            algorithm: .p256,
            signer: authorityKey,
            signerAlgorithm: .p256,
            names: nil
        )
        authority = try XCTUnwrap(SecCertificateCreateWithData(nil, Data(der) as CFData), "authority certificate")
    }

    deinit {
        SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: Data(tag.utf8)] as CFDictionary)
        for label in labels {
            SecItemDelete([kSecClass: kSecClassCertificate, kSecAttrLabel: label] as CFDictionary)
        }
    }

    /// A server identity for `name`, issued by this authority.
    func leaf(name: String = "localhost", algorithm: Algorithm = .p256) throws -> Leaf {
        let key = try Self.makeKey(algorithm, tag: tag)
        let der = try Self.certificate(
            subject: name,
            issuer: "Loom Test Authority",
            subjectKey: key,
            algorithm: algorithm,
            signer: authorityKey,
            signerAlgorithm: .p256,
            names: [name]
        )
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, Data(der) as CFData), "leaf certificate")
        let label = "\(tag).\(labels.count)"
        labels.append(label)
        let added = SecItemAdd([kSecClass: kSecClassCertificate, kSecValueRef: certificate, kSecAttrLabel: label] as CFDictionary, nil)
        guard added == errSecSuccess else { throw XCTSkip("the simulator keychain refused a test certificate (\(added))") }
        var found: CFTypeRef?
        let status = SecItemCopyMatching(
            [kSecClass: kSecClassIdentity, kSecAttrLabel: label, kSecReturnRef: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary,
            &found
        )
        guard status == errSecSuccess, let found else { throw XCTSkip("no test TLS identity is available here (\(status))") }
        let spki = try Self.spki(of: key, algorithm)
        return Leaf(
            certificate: certificate,
            identity: found as! SecIdentity,
            spkiFingerprint: Data(SHA256.hash(data: Data(spki))).base64EncodedString()
        )
    }

    // MARK: Keys

    private static func makeKey(_ algorithm: Algorithm, tag: String?) throws -> SecKey {
        var attributes: [CFString: Any] = [
            kSecAttrKeyType: algorithm == .p256 ? kSecAttrKeyTypeECSECPrimeRandom : kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits: algorithm == .p256 ? 256 : 2048
        ]
        if let tag {
            attributes[kSecPrivateKeyAttrs] = [kSecAttrIsPermanent: true, kSecAttrApplicationTag: Data(tag.utf8)] as [CFString: Any]
        }
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw XCTSkip("the simulator could not make a test key: \(String(describing: error?.takeRetainedValue()))")
        }
        return key
    }

    private static func spki(of key: SecKey, _ algorithm: Algorithm) throws -> [UInt8] {
        let publicKey = try XCTUnwrap(SecKeyCopyPublicKey(key))
        let raw = [UInt8](try XCTUnwrap(SecKeyCopyExternalRepresentation(publicKey, nil)) as Data)
        switch algorithm {
        case .p256:
            // id-ecPublicKey with prime256v1, then the X9.63 point.
            return DER.sequence(DER.sequence(DER.oid([0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]), DER.oid([0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07])), DER.bits(raw))
        case .rsa2048:
            // rsaEncryption with NULL parameters, then the PKCS#1 key.
            return DER.sequence(DER.sequence(DER.oid([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01]), [0x05, 0x00]), DER.bits(raw))
        }
    }

    // MARK: Certificates

    private static func certificate(
        subject: String,
        issuer: String,
        subjectKey: SecKey,
        algorithm: Algorithm,
        signer: SecKey,
        signerAlgorithm: Algorithm,
        names: [String]?
    ) throws -> [UInt8] {
        let signature = DER.sequence(DER.oid([0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02])) // ecdsa-with-SHA256
        precondition(signerAlgorithm == .p256)
        func name(_ common: String) -> [UInt8] {
            DER.sequence(DER.set(DER.sequence(DER.oid([0x55, 0x04, 0x03]), DER.utf8(common))))
        }
        func ext(_ id: [UInt8], critical: Bool = false, _ value: [UInt8]) -> [UInt8] {
            DER.sequence(DER.oid(id), critical ? [0x01, 0x01, 0xFF] : [], DER.octets(value))
        }
        let extensions: [UInt8]
        if let names {
            extensions = DER.sequence(
                ext([0x55, 0x1D, 0x13], critical: true, DER.sequence()),
                ext([0x55, 0x1D, 0x0F], critical: true, [0x03, 0x02, 0x07, 0x80]), // digitalSignature
                ext([0x55, 0x1D, 0x25], DER.sequence(DER.oid([0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01]))), // serverAuth
                ext([0x55, 0x1D, 0x11], DER.sequence(names.flatMap { DER.tagged(0x82, Array($0.utf8)) }))
            )
        } else {
            extensions = DER.sequence(
                ext([0x55, 0x1D, 0x13], critical: true, DER.sequence([0x01, 0x01, 0xFF])),
                ext([0x55, 0x1D, 0x0F], critical: true, [0x03, 0x02, 0x01, 0x06]) // keyCertSign, cRLSign
            )
        }
        var serial = [UInt8](repeating: 0, count: 8)
        _ = SecRandomCopyBytes(kSecRandomDefault, serial.count, &serial)
        serial[0] = (serial[0] & 0x7F) | 0x01
        let now = Date()
        let tbs = DER.sequence(
            DER.tagged(0xA0, DER.integer([2])),
            DER.integer(serial),
            signature,
            name(issuer),
            DER.sequence(DER.time(now.addingTimeInterval(-3600)), DER.time(now.addingTimeInterval(90 * 86400))),
            name(subject),
            try spki(of: subjectKey, algorithm),
            DER.tagged(0xA3, extensions)
        )
        var error: Unmanaged<CFError>?
        guard let signed = SecKeyCreateSignature(signer, .ecdsaSignatureMessageX962SHA256, Data(tbs) as CFData, &error) else {
            throw XCTSkip("the simulator could not sign a test certificate")
        }
        return DER.sequence(tbs, signature, DER.bits([UInt8](signed as Data)))
    }
}

private enum DER {
    static func tagged(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] {
        var length: [UInt8]
        if content.count < 0x80 {
            length = [UInt8(content.count)]
        } else {
            var bytes: [UInt8] = []
            var remaining = content.count
            while remaining > 0 {
                bytes.insert(UInt8(remaining & 0xFF), at: 0)
                remaining >>= 8
            }
            length = [0x80 | UInt8(bytes.count)] + bytes
        }
        return [tag] + length + content
    }

    static func sequence(_ items: [UInt8]...) -> [UInt8] { tagged(0x30, items.flatMap { $0 }) }
    static func set(_ items: [UInt8]...) -> [UInt8] { tagged(0x31, items.flatMap { $0 }) }
    static func oid(_ bytes: [UInt8]) -> [UInt8] { tagged(0x06, bytes) }
    static func utf8(_ text: String) -> [UInt8] { tagged(0x0C, Array(text.utf8)) }
    static func octets(_ bytes: [UInt8]) -> [UInt8] { tagged(0x04, bytes) }
    static func bits(_ bytes: [UInt8]) -> [UInt8] { tagged(0x03, [0x00] + bytes) }
    static func integer(_ bytes: [UInt8]) -> [UInt8] { tagged(0x02, (bytes.first ?? 0) & 0x80 != 0 ? [0x00] + bytes : bytes) }

    static func time(_ date: Date) -> [UInt8] {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(identifier: "UTC")
        format.dateFormat = "yyMMddHHmmss'Z'"
        return tagged(0x17, Array(format.string(from: date).utf8))
    }
}
