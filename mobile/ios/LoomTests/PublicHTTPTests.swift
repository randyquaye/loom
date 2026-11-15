import XCTest
@testable import Loom

/// Unauthenticated evidence fetches: no redirects, a hard deadline and a small reply.
final class PublicHTTPTests: XCTestCase {
    private func client(timeout: TimeInterval = 15) -> PublicHTTP {
        var client = PublicHTTP(timeout: timeout)
        client.allowsLoopbackForTests = true
        return client
    }

    private func url(_ server: RawServer, _ path: String = "/auth/transport") -> URL {
        URL(string: "http://127.0.0.1:\(server.port)\(path)")!
    }

    func testFetchesASmallReply() async throws {
        let server = try RawServer { RawServer.requestComplete($0) ? RawServer.http("200 OK", body: #"{"ok":true}"#) : nil }
        let body = try await client().get(url(server), accept: "application/json")
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"ok":true}"#)
        let request = String(decoding: server.received[0], as: UTF8.self)
        XCTAssertTrue(request.hasPrefix("GET /auth/transport HTTP/1.1\r\n"))
        XCTAssertTrue(request.lowercased().contains("accept: application/json"))
        XCTAssertFalse(request.lowercased().contains("cookie:"))
    }

    func testRedirectsAreNeverFollowed() async throws {
        let target = try RawServer { RawServer.requestComplete($0) ? RawServer.http("200 OK", body: "followed") : nil }
        for status in ["301 Moved Permanently", "302 Found", "307 Temporary Redirect", "308 Permanent Redirect"] {
            let location = "Location: http://127.0.0.1:\(target.port)/elsewhere"
            let server = try RawServer { RawServer.requestComplete($0) ? RawServer.http(status, headers: [location]) : nil }
            await XCTAssertThrowsAsync(try await client().get(url(server), accept: "application/json"), status)
            await XCTAssertThrowsAsync(try await client().postForm(url(server, "/auth/proof"), fields: [("code", "loom_code_1")]), status)
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(target.received.count, 0, "nothing, least of all a code, is re-sent to a redirect target")
    }

    func testFormPostCarriesItsFieldsAndReturnsRefusals() async throws {
        let server = try RawServer { RawServer.requestComplete($0) ? RawServer.http("400 Bad Request", body: #"{"error":"invalid_grant"}"#) : nil }
        let reply = try await client().postForm(url(server, "/auth/proof"), fields: [("code", "loom code/1"), ("redirect_uri", "dev.loom.app.ios:/oauth/callback")])
        XCTAssertEqual(reply.status, 400)
        XCTAssertEqual(String(decoding: reply.body, as: UTF8.self), #"{"error":"invalid_grant"}"#)
        let request = String(decoding: server.received[0], as: UTF8.self)
        XCTAssertTrue(request.hasPrefix("POST /auth/proof HTTP/1.1\r\n"))
        XCTAssertTrue(request.hasSuffix("\r\n\r\ncode=loom%20code%2F1&redirect_uri=dev.loom.app.ios%3A%2Foauth%2Fcallback"), request)
    }

    func testReplyOverSixtyFourKibibytesIsRefused() async throws {
        let limit = 64 * 1024
        let fits = try RawServer { RawServer.requestComplete($0) ? RawServer.http("200 OK", body: String(repeating: "a", count: limit)) : nil }
        let body = try await client().get(url(fits), accept: "application/json")
        XCTAssertEqual(body.count, limit)

        let over = try RawServer { RawServer.requestComplete($0) ? RawServer.http("200 OK", body: String(repeating: "a", count: limit + 1)) : nil }
        await XCTAssertThrowsAsync(try await client().get(url(over), accept: "application/json"))

        // A reply that does not declare its length is cut off at the same bound.
        let undeclared = try RawServer { request in
            RawServer.requestComplete(request) ? Data(("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + String(repeating: "a", count: 200_000)).utf8) : nil
        }
        await XCTAssertThrowsAsync(try await client().get(url(undeclared), accept: "application/json"))
    }

    func testSilentServerMeetsTheDeadline() async throws {
        let server = try RawServer { _ in nil }
        let began = Date()
        await XCTAssertThrowsAsync(try await client(timeout: 0.5).get(url(server), accept: "application/json"))
        XCTAssertLessThan(Date().timeIntervalSince(began), 5)
    }

    func testErrorStatusIsNotEvidence() async throws {
        let server = try RawServer { RawServer.requestComplete($0) ? RawServer.http("503 Service Unavailable", body: #"{"error":"Host verification is not ready"}"#) : nil }
        await XCTAssertThrowsAsync(try await client().get(url(server), accept: "application/json"))
    }

    func testOnlyHTTPSLeavesTheDevice() async {
        let client = PublicHTTP()
        for address in ["http://loom.example.com/auth/transport", "http://127.0.0.1:9/auth/transport", "ftp://loom.example.com/x"] {
            await XCTAssertThrowsAsync(try await client.get(URL(string: address)!, accept: "application/json"), address)
        }
    }

    // MARK: Pinned replies

    func testPinnedReplyParsing() throws {
        func parse(_ text: String, complete: Bool = true) throws -> HTTPReply? {
            var parser = HTTPReplyParser(maxBodyBytes: 64 * 1024)
            // Fed in small pieces: boundaries can fall anywhere.
            let bytes = Array(text.utf8)
            for start in stride(from: 0, to: bytes.count, by: 7) {
                if let reply = try parser.feed(Data(bytes[start..<min(start + 7, bytes.count)])) { return reply }
            }
            return complete ? try parser.finish() : nil
        }

        let sized = try XCTUnwrap(parse("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\ncontent-length: 7\r\n\r\n{\"a\":1}ignored"))
        XCTAssertEqual(sized.status, 200)
        XCTAssertEqual(String(decoding: sized.body, as: UTF8.self), #"{"a":1}"#)

        let chunked = try XCTUnwrap(parse("HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"er\r\nA;ext=1\r\nror\":\"no\"}\r\n0\r\n\r\n"))
        XCTAssertEqual(chunked.status, 400)
        XCTAssertEqual(String(decoding: chunked.body, as: UTF8.self), #"{"error":"no"}"#)

        let untilClose = try XCTUnwrap(parse("HTTP/1.1 502 Bad Gateway\r\n\r\nupstream down"))
        XCTAssertEqual(untilClose.status, 502)
        XCTAssertEqual(String(decoding: untilClose.body, as: UTF8.self), "upstream down")

        let empty = try XCTUnwrap(parse("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"))
        XCTAssertEqual(empty.body.count, 0)

        XCTAssertThrowsError(try parse("HTTP/1.1 200 OK\r\nContent-Length: 70000\r\n\r\n"), "declared too large")
        XCTAssertThrowsError(try parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n11170\r\n"), "chunk too large")
        XCTAssertThrowsError(try parse("HTTP/1.1 200 OK\r\n\r\n" + String(repeating: "x", count: 70_000)), "unbounded body")
        XCTAssertThrowsError(try parse("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nshort"), "ended early")
        XCTAssertThrowsError(try parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n"), "chunks never finished")
        XCTAssertThrowsError(try parse("SSH-2.0-OpenSSH\r\n\r\n"), "not HTTP")
        XCTAssertThrowsError(try parse("HTTP/1.1 200 OK\r\n" + String(repeating: "X-Pad: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n", count: 600)), "headers without end")
    }
}
