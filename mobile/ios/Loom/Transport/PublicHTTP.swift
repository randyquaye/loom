import Foundation

enum HTTPFailure: LocalizedError {
    case notAllowed
    case redirected
    case tooLarge
    case timedOut
    case status(Int)
    case malformed

    var errorDescription: String? {
        switch self {
        case .notAllowed: return "Only HTTPS addresses can be contacted."
        case .redirected: return "The server tried to redirect a verification request, which is never followed."
        case .tooLarge: return "The server's reply was larger than a verification reply can be."
        case .timedOut: return "The server took too long to answer."
        case .status(let code): return "The server answered \(code)."
        case .malformed: return "The server's reply could not be read."
        }
    }
}

/// Runs `operation`, giving up after `seconds`.
func withDeadline<Value>(_ seconds: TimeInterval, _ operation: @escaping () async throws -> Value) async throws -> Value {
    try await withThrowingTaskGroup(of: Value.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw HTTPFailure.timedOut
        }
        defer { group.cancelAll() }
        return try await group.next()!
    }
}

/// Fetches public evidence and posts the one-time code for its proof. These requests carry no
/// credential, so ordinary TLS is enough, but they still never follow a redirect, never share
/// cookies or caches, stop after 15 seconds and accept at most 64 KiB.
struct PublicHTTP {
    var timeout: TimeInterval = 15
    var maxBytes = 64 * 1024
    #if DEBUG
    /// Lets tests reach a loopback fixture over plain HTTP; compiled out of release builds.
    var allowsLoopbackForTests = false
    #endif

    private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    private func allowed(_ url: URL) -> Bool {
        if url.scheme == "https" { return true }
        #if DEBUG
        return allowsLoopbackForTests && url.scheme == "http" && url.host == "127.0.0.1"
        #else
        return false
        #endif
    }

    /// The body of a successful reply.
    func get(_ url: URL, accept: String) async throws -> Data {
        var request = URLRequest(url: url)
        request.setValue(accept, forHTTPHeaderField: "Accept")
        let reply = try await perform(request)
        guard (200..<300).contains(reply.status) else { throw HTTPFailure.status(reply.status) }
        return reply.body
    }

    /// The reply whatever its status, so a refusal can be told from an outage.
    func postForm(_ url: URL, fields: [(String, String)]) async throws -> HTTPReply {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(formBody(fields).utf8)
        return try await perform(request)
    }

    private func perform(_ request: URLRequest) async throws -> HTTPReply {
        guard let url = request.url, allowed(url) else { throw HTTPFailure.notAllowed }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let limit = maxBytes
        return try await withDeadline(timeout) {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw HTTPFailure.malformed }
            if (300..<400).contains(http.statusCode) { throw HTTPFailure.redirected }
            if http.expectedContentLength > Int64(limit) { throw HTTPFailure.tooLarge }
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count > limit { throw HTTPFailure.tooLarge }
            }
            return HTTPReply(status: http.statusCode, body: body)
        }
    }
}

/// Reads one HTTP/1.1 reply off a pinned connection, bounded in size, whatever framing the
/// server or its TLS front chose.
struct HTTPReplyParser {
    private enum Framing {
        case length(Int)
        case chunked
        case untilClose
    }

    private let maxBodyBytes: Int
    private let maxHeaderBytes: Int
    private var buffer: [UInt8] = []
    private var scanned = 0
    private var status = 0
    private var framing: Framing?
    private var body: [UInt8] = []

    init(maxBodyBytes: Int, maxHeaderBytes: Int = 16 * 1024) {
        self.maxBodyBytes = maxBodyBytes
        self.maxHeaderBytes = maxHeaderBytes
    }

    private func find(_ pattern: [UInt8], from start: Int = 0) -> Int? {
        guard buffer.count >= pattern.count + start else { return nil }
        return (start...(buffer.count - pattern.count)).first { buffer[$0...].starts(with: pattern) }
    }

    /// Returns the reply once it is complete; nil while more bytes are needed.
    mutating func feed(_ data: Data) throws -> HTTPReply? {
        buffer.append(contentsOf: data)
        if framing == nil {
            // Each byte is searched once, however small the pieces arrive.
            guard let end = find([0x0D, 0x0A, 0x0D, 0x0A], from: max(0, scanned - 3)) else {
                scanned = buffer.count
                if buffer.count > maxHeaderBytes { throw HTTPFailure.malformed }
                return nil
            }
            guard end <= maxHeaderBytes else { throw HTTPFailure.malformed }
            let lines = String(decoding: buffer[..<end], as: UTF8.self).components(separatedBy: "\r\n")
            let first = lines[0].split(separator: " ", maxSplits: 2)
            guard first.count >= 2, first[0].hasPrefix("HTTP/1."), let code = Int(first[1]), (100...599).contains(code) else {
                throw HTTPFailure.malformed
            }
            status = code
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { throw HTTPFailure.malformed }
                headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            buffer.removeFirst(end + 4)
            if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
                framing = .chunked
            } else if let declared = headers["content-length"] {
                guard let length = Int(declared), length >= 0 else { throw HTTPFailure.malformed }
                guard length <= maxBodyBytes else { throw HTTPFailure.tooLarge }
                framing = .length(length)
            } else {
                framing = .untilClose
            }
        }
        switch framing! {
        case .length(let length):
            return buffer.count >= length ? HTTPReply(status: status, body: Data(buffer[..<length])) : nil
        case .untilClose:
            if buffer.count > maxBodyBytes { throw HTTPFailure.tooLarge }
            return nil
        case .chunked:
            while let lineEnd = find([0x0D, 0x0A]) {
                let sizeText = String(decoding: buffer[..<lineEnd], as: UTF8.self).split(separator: ";").first.map(String.init) ?? ""
                guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16), size >= 0 else { throw HTTPFailure.malformed }
                guard body.count + size <= maxBodyBytes else { throw HTTPFailure.tooLarge }
                if size == 0 { return HTTPReply(status: status, body: Data(body)) }
                let start = lineEnd + 2
                guard buffer.count >= start + size + 2 else { return nil }
                body.append(contentsOf: buffer[start..<(start + size)])
                buffer.removeFirst(start + size + 2)
            }
            if buffer.count > 64 { throw HTTPFailure.malformed }
            return nil
        }
    }

    /// The connection ended. Only a reply framed by its end, or already whole, is acceptable.
    mutating func finish() throws -> HTTPReply {
        switch framing {
        case .untilClose: return HTTPReply(status: status, body: Data(buffer))
        case .length(let length) where buffer.count >= length: return HTTPReply(status: status, body: Data(buffer[..<length]))
        default: throw HTTPFailure.malformed
        }
    }
}
