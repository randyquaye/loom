import Foundation

/// Finds a certificate's SubjectPublicKeyInfo exactly as it is encoded.
///
/// The runner signs SHA-256 over the leaf's whole SPKI. `SecKeyCopyExternalRepresentation`
/// returns only the bare key, so the SPKI is read out of the certificate's own DER instead.
/// That works for every key type and refuses anything it cannot walk.
enum SPKI {
    private struct Element {
        let tag: UInt8
        let content: ArraySlice<UInt8>
        /// Tag, length and content together.
        let whole: ArraySlice<UInt8>
    }

    /// Reads one definite-length DER element from the front of `bytes`.
    private static func next(_ bytes: inout ArraySlice<UInt8>) -> Element? {
        let start = bytes.startIndex
        guard bytes.count >= 2 else { return nil }
        let tag = bytes[start]
        // Multi-byte tag numbers never occur where this walks.
        guard tag & 0x1F != 0x1F else { return nil }
        var offset = start + 2
        var length = Int(bytes[start + 1])
        if length & 0x80 != 0 {
            let count = length & 0x7F
            guard (1...4).contains(count), bytes.count >= 2 + count else { return nil }
            length = 0
            for index in 0..<count { length = (length << 8) | Int(bytes[start + 2 + index]) }
            // DER: the shortest form only.
            guard length >= 0x80, count == 1 || bytes[start + 2] != 0 else { return nil }
            offset += count
        }
        guard length <= bytes.endIndex - offset else { return nil }
        let end = offset + length
        defer { bytes = bytes[end...] }
        return Element(tag: tag, content: bytes[offset..<end], whole: bytes[start..<end])
    }

    static func subjectPublicKeyInfo(certificateDER: Data) -> Data? {
        var input = Array(certificateDER)[...]
        // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
        guard let certificate = next(&input), certificate.tag == 0x30, input.isEmpty else { return nil }
        var outer = certificate.content
        guard let tbs = next(&outer), tbs.tag == 0x30 else { return nil }
        // TBSCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber, signature, issuer,
        //                               validity, subject, subjectPublicKeyInfo, ... }
        var fields = tbs.content
        guard var field = next(&fields) else { return nil }
        if field.tag == 0xA0 {
            guard let serial = next(&fields) else { return nil }
            field = serial
        }
        guard field.tag == 0x02 else { return nil }
        for _ in 0..<4 {
            guard let skipped = next(&fields), skipped.tag == 0x30 else { return nil }
        }
        guard let spki = next(&fields), spki.tag == 0x30 else { return nil }
        // SubjectPublicKeyInfo ::= SEQUENCE { algorithm AlgorithmIdentifier, subjectPublicKey BIT STRING }
        var parts = spki.content
        guard let algorithm = next(&parts), algorithm.tag == 0x30, let key = next(&parts), key.tag == 0x03, parts.isEmpty else { return nil }
        return Data(spki.whole)
    }
}
