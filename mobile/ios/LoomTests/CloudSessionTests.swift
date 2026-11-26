import XCTest
@testable import Loom

private func tokens(_ number: Int, expiresIn: Int = 3600) -> HTTPReply {
    HTTPReply(status: 200, body: Data(#"{"access_token":"loom_at_\#(number)","refresh_token":"loom_rt_\#(number)","token_type":"Bearer","expires_in":\#(expiresIn)}"#.utf8))
}

private let invalidGrant = HTTPReply(status: 400, body: Data(#"{"error":"invalid_grant","error_description":"Refresh token was already used"}"#.utf8))

final class CloudSessionTests: XCTestCase {
    private var store: KeychainCredentialStore!
    private var clock: Locked<Int64>!
    private let record = CredentialRecord(origin: "https://loom.example.com", trustDomain: "example.com", email: "developer@example.com", refreshToken: "loom_rt_0")

    override func setUp() {
        store = KeychainCredentialStore(service: "dev.loom.app.ios.tests.\(UUID().uuidString)")
        clock = Locked(1_800_000_000_000)
    }

    override func tearDown() { try? store.clear() }

    private func session(_ transport: RecordingTransport, saved: Bool = true) throws -> CloudSession {
        if saved { try store.save(record) }
        let clock = clock!
        return CloudSession(store: store, transport: { _ in transport }, now: { clock.value })
    }

    // MARK: Keychain

    func testKeychainKeepsOneRecordAndReplacesItWhole() throws {
        XCTAssertNil(try store.load())
        try store.save(record)
        XCTAssertEqual(try store.load(), record)

        var rotated = record
        rotated.refreshToken = "loom_rt_1"
        try store.save(rotated)
        XCTAssertEqual(try store.load(), rotated)
        XCTAssertEqual(try KeychainCredentialStore(service: store.service).load()?.refreshToken, "loom_rt_1", "survives a new process")

        try store.clear()
        XCTAssertNil(try store.load())
        try store.clear()
    }

    func testCredentialsStayOnThisDeviceOnly() throws {
        try store.save(record)
        var found: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass: kSecClassGenericPassword, kSecAttrService: store.service,
                kSecAttrSynchronizable: kSecAttrSynchronizableAny, kSecReturnAttributes: true
            ] as CFDictionary,
            &found
        )
        XCTAssertEqual(status, errSecSuccess)
        let attributes = try XCTUnwrap(found as? [String: Any])
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertNotEqual(attributes[kSecAttrSynchronizable as String] as? Bool, true)
    }

    func testUnreadableOrOlderRecordsMeanSignedOut() throws {
        let stale = #"{"version":2,"origin":"https://loom.example.com","trustDomain":"example.com","email":"d@example.com","refreshToken":"loom_rt_0"}"#
        for body in [stale, "not json", #"{"version":3,"origin":"http://loom.example.com","trustDomain":"example.com","email":"d@example.com","refreshToken":"x"}"#] {
            try store.clear()
            XCTAssertEqual(
                SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrService: store.service, kSecAttrAccount: "runner", kSecValueData: Data(body.utf8)] as CFDictionary, nil),
                errSecSuccess
            )
            XCTAssertNil(try store.load(), body)
        }
    }

    // MARK: Renewal

    func testRenewalRotatesAndSavesBeforeTheNewTokenIsUsed() async throws {
        let transport = RecordingTransport(replies: [tokens(1), tokens(2)])
        let session = try session(transport)
        let first = try await session.accessToken()
        XCTAssertEqual(first, "loom_at_1")
        XCTAssertEqual(transport.requests, [.init(path: "/auth/token", fields: ["grant_type": "refresh_token", "refresh_token": "loom_rt_0"])])
        XCTAssertEqual(try store.load()?.refreshToken, "loom_rt_1")

        // Still fresh: no second renewal.
        clock.update { $0 += 3_000_000 }
        let again = try await session.accessToken()
        XCTAssertEqual(again, "loom_at_1")
        XCTAssertEqual(transport.requests.count, 1)

        // Inside the last minute it renews, with the rotated token.
        clock.update { $0 += 545_000 }
        let renewed = try await session.accessToken()
        XCTAssertEqual(renewed, "loom_at_2")
        XCTAssertEqual(transport.requests.last?.fields["refresh_token"], "loom_rt_1")
        XCTAssertEqual(try store.load()?.refreshToken, "loom_rt_2")
    }

    func testOverlappingCallersShareOneRenewal() async throws {
        let transport = RecordingTransport(replies: [tokens(1), invalidGrant])
        transport.delayNanoseconds = 150_000_000
        let session = try session(transport)
        let results = try await withThrowingTaskGroup(of: String?.self) { group -> [String?] in
            for _ in 0..<8 { group.addTask { try await session.accessToken() } }
            return try await group.reduce(into: []) { $0.append($1) }
        }
        XCTAssertEqual(results, Array(repeating: "loom_at_1", count: 8))
        XCTAssertEqual(transport.requests.count, 1, "a refresh token is single use: a second renewal would end the sign-in")
    }

    func testInvalidationForcesARenewal() async throws {
        let transport = RecordingTransport(replies: [tokens(1), tokens(2)])
        let session = try session(transport)
        _ = try await session.accessToken()
        await session.invalidateAccess()
        let renewed = try await session.accessToken()
        XCTAssertEqual(renewed, "loom_at_2")
    }

    func testRefusedRenewalEndsTheLocalSession() async throws {
        let transport = RecordingTransport(replies: [invalidGrant])
        let session = try session(transport)
        let token = try await session.accessToken()
        XCTAssertNil(token)
        XCTAssertNil(try store.load(), "a revoked sign-in leaves nothing behind")
        let account = try await session.account
        XCTAssertNil(account)
        let again = try await session.accessToken()
        XCTAssertNil(again)
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testUnreachableOrUnprovenRunnerKeepsTheCredentials() async throws {
        // The TLS front answering while the runner restarts is not the runner's refusal.
        let transport = RecordingTransport(replies: [
            HTTPReply(status: 502, body: Data("Bad Gateway".utf8)),
            HTTPReply(status: 400, body: Data("<html>".utf8)),
            HTTPReply(status: 200, body: Data(#"{"access_token":"loom_at_1"}"#.utf8))
        ])
        let session = try session(transport)
        for _ in 0..<3 {
            await XCTAssertThrowsAsync(try await session.accessToken())
            XCTAssertEqual(try store.load(), record)
        }
        transport.failure = TrustFailure("The cloud host could not prove its current TLS connection")
        await XCTAssertThrowsAsync(try await session.accessToken())
        XCTAssertEqual(try store.load(), record)
        let account = try await session.account
        XCTAssertEqual(account, record)
    }

    func testNoSavedSignInMeansNoRequests() async throws {
        let transport = RecordingTransport(replies: [tokens(1)])
        let session = try session(transport, saved: false)
        let token = try await session.accessToken()
        XCTAssertNil(token)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    // MARK: Signing in and out

    func testAdoptingASignInSavesItAndServesItsAccessToken() async throws {
        let transport = RecordingTransport(replies: [])
        let session = try session(transport, saved: false)
        try await session.adopt(SignInResult(record: record, accessToken: "loom_at_0", expiresIn: 3600))
        XCTAssertEqual(try store.load(), record)
        let token = try await session.accessToken()
        XCTAssertEqual(token, "loom_at_0")
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testSignOutClearsLocallyFirstThenRevokesOnThePinnedTransport() async throws {
        let transport = RecordingTransport(replies: [tokens(1), HTTPReply(status: 200, body: Data())])
        let session = try session(transport)
        _ = try await session.accessToken()
        transport.delayNanoseconds = 200_000_000
        let signingOut = Task { try await session.signOut() }
        await waitUntil(message: "revocation in flight") { transport.requests.count == 2 }
        XCTAssertNil(try store.load(), "cleared before the runner has answered")
        try await signingOut.value
        XCTAssertEqual(transport.requests.last, .init(path: "/auth/revoke", fields: ["token": "loom_rt_1"]))
        let token = try await session.accessToken()
        XCTAssertNil(token)
    }

    func testSignOutSurvivesAnUnreachableRunner() async throws {
        let transport = RecordingTransport(replies: [])
        transport.failure = URLError(.notConnectedToInternet)
        let session = try session(transport)
        try await session.signOut()
        XCTAssertNil(try store.load())
        let account = try await session.account
        XCTAssertNil(account)
    }

    // MARK: Storage that fails

    private func controlled(_ transport: RecordingTransport, saved: Bool = true) throws -> (CloudSession, ControlledStore) {
        if saved { try store.save(record) }
        let controlled = ControlledStore(store)
        let clock = clock!
        return (CloudSession(store: controlled, transport: { _ in transport }, now: { clock.value }), controlled)
    }

    /// The runner has already consumed loom_rt_0 when the new pair arrives. Until loom_rt_1 is
    /// on disk, its access token is not used: a crash would leave a dead token behind it.
    func testRotationThatCannotBeSavedIsNotUsedUntilItIs() async throws {
        let transport = RecordingTransport(replies: [tokens(1), tokens(2)])
        let (session, controlled) = try controlled(transport)
        controlled.failSaves = errSecInteractionNotAllowed

        await XCTAssertThrowsAsync(try await session.accessToken(), "uncommitted access must not be handed out") {
            XCTAssertEqual(($0 as? KeychainCredentialStore.Failure)?.status, errSecInteractionNotAllowed)
        }
        XCTAssertEqual(try store.load()?.refreshToken, "loom_rt_0", "nothing durable changed")
        await XCTAssertThrowsAsync(try await session.accessToken())
        XCTAssertEqual(transport.requests.count, 1, "the consumed token is never presented again, and nothing renews twice")

        controlled.failSaves = nil
        let token = try await session.accessToken()
        XCTAssertEqual(token, "loom_at_1", "the same pair, once it is durable")
        XCTAssertEqual(try store.load()?.refreshToken, "loom_rt_1")
        XCTAssertEqual(transport.requests.count, 1)
        let account = try await session.account
        XCTAssertEqual(account?.refreshToken, "loom_rt_1")
    }

    func testSignOutWhileARotationIsUnsavedRevokesTheLiveToken() async throws {
        let transport = RecordingTransport(replies: [tokens(1), HTTPReply(status: 200, body: Data())])
        let (session, controlled) = try controlled(transport)
        controlled.failSaves = errSecInteractionNotAllowed
        await XCTAssertThrowsAsync(try await session.accessToken())
        try await session.signOut()
        XCTAssertEqual(transport.requests.last, .init(path: "/auth/revoke", fields: ["token": "loom_rt_1"]), "the runner's live token, not the consumed one")
        XCTAssertNil(try store.load())
        controlled.failSaves = nil
        let token = try await session.accessToken()
        XCTAssertNil(token)
    }

    func testSignInThatCannotBeSavedIsNotAdoptedAndIsRevoked() async throws {
        let transport = RecordingTransport(replies: [HTTPReply(status: 200, body: Data())])
        let (session, controlled) = try controlled(transport, saved: false)
        controlled.failSaves = errSecInteractionNotAllowed
        await XCTAssertThrowsAsync(try await session.adopt(SignInResult(record: record, accessToken: "loom_at_0", expiresIn: 3600))) {
            XCTAssertNotNil($0 as? LocalizedError, "the person is told why sign-in did not finish")
        }
        let account = try await session.account
        XCTAssertNil(account)
        let token = try await session.accessToken()
        XCTAssertNil(token, "an access token whose sign-in is not saved is never served")
        await waitUntil(message: "orphaned sign-in revoked") {
            transport.requests.contains(.init(path: "/auth/revoke", fields: ["token": "loom_rt_0"]))
        }
    }

    /// A locked device is not a signed-out one: nothing is asked of the runner, nothing is erased.
    func testUnreadableKeychainIsRetryableAndNeverMeansSignedOut() async throws {
        let transport = RecordingTransport(replies: [tokens(1)])
        let (session, controlled) = try controlled(transport)
        controlled.failLoads = errSecInteractionNotAllowed

        await XCTAssertThrowsAsync(try await session.account)
        await XCTAssertThrowsAsync(try await session.accessToken())
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertEqual(try store.load(), record, "the saved sign-in is untouched")

        controlled.failLoads = nil
        let account = try await session.account
        XCTAssertEqual(account, record)
        let token = try await session.accessToken()
        XCTAssertEqual(token, "loom_at_1")
    }

    func testSignOutDuringARenewalIsNotUndoneByItsAnswer() async throws {
        let transport = RecordingTransport(replies: [tokens(1), HTTPReply(status: 200, body: Data()), HTTPReply(status: 200, body: Data())])
        transport.delayNanoseconds = 250_000_000
        let session = try session(transport)
        let renewing = Task { try await session.accessToken() }
        await waitUntil(message: "renewal in flight") { transport.requests.count == 1 }
        try await session.signOut()
        let late = try await renewing.value
        XCTAssertNil(late, "the renewed token belongs to a sign-in that has ended")
        XCTAssertNil(try store.load())
        await waitUntil(message: "rotated token revoked too") {
            transport.requests.contains(.init(path: "/auth/revoke", fields: ["token": "loom_rt_1"]))
        }
    }
}

/// The real Keychain store, with failures a test switches on, as a locked device produces them.
final class ControlledStore: CredentialStore, @unchecked Sendable {
    private let real: KeychainCredentialStore
    private let failures = Locked<(load: OSStatus?, save: OSStatus?, clear: OSStatus?)>((nil, nil, nil))

    init(_ real: KeychainCredentialStore) { self.real = real }

    var failLoads: OSStatus? {
        get { failures.value.load }
        set { failures.update { $0.load = newValue } }
    }

    var failSaves: OSStatus? {
        get { failures.value.save }
        set { failures.update { $0.save = newValue } }
    }

    func load() throws -> CredentialRecord? {
        if let status = failLoads { throw KeychainCredentialStore.Failure(status: status) }
        return try real.load()
    }

    func save(_ record: CredentialRecord) throws {
        if let status = failSaves { throw KeychainCredentialStore.Failure(status: status) }
        try real.save(record)
    }

    var failClears: OSStatus? {
        get { failures.value.clear }
        set { failures.update { $0.clear = newValue } }
    }

    func clear() throws {
        if let status = failClears { throw KeychainCredentialStore.Failure(status: status) }
        try real.clear()
    }
}
