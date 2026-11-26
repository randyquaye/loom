import Foundation
import Security

struct HTTPReply: Equatable {
    let status: Int
    let body: Data
}

/// Carries a credential to the runner. The one real implementation is `PinnedTransport`.
protocol CredentialTransport {
    func post(path: String, fields: [(String, String)]) async throws -> HTTPReply
}

/// Supplies the bearer token for a connection, renewing it when it has to.
protocol TokenSource: Sendable {
    /// Nil when there is no sign-in. Throws when one exists but cannot be renewed right now.
    func accessToken() async throws -> String?
    /// The runner turned the current token away: the next ask renews instead of reusing it.
    func invalidateAccess() async
}

/// Everything a later launch needs, saved and replaced as one item: the host, the independently
/// verified Workspace domain that authorizes it, and the refresh token.
struct CredentialRecord: Codable, Equatable, CustomStringConvertible {
    private(set) var version = 3
    let origin: String
    let trustDomain: String
    let email: String
    var refreshToken: String

    init(origin: String, trustDomain: String, email: String, refreshToken: String) {
        self.origin = origin
        self.trustDomain = trustDomain
        self.email = email
        self.refreshToken = refreshToken
    }

    /// Never prints the token, wherever a record ends up being described.
    var description: String { "CredentialRecord(\(email), \(origin))" }

    fileprivate var isUsable: Bool {
        version == 3 && (try? HostOrigin(origin))?.origin == origin && TrustVerifier.isDomain(trustDomain) && !refreshToken.isEmpty
    }
}

/// Where the one credential record rests between launches.
protocol CredentialStore: Sendable {
    /// Nil when nothing usable is saved. Throws when storage cannot be read right now.
    func load() throws -> CredentialRecord?
    func save(_ record: CredentialRecord) throws
    func clear() throws
}

/// The refresh credential rests in the Keychain: this device only, readable only while unlocked,
/// never synced or backed up to another device.
struct KeychainCredentialStore: CredentialStore {
    struct Failure: LocalizedError {
        let status: OSStatus

        var errorDescription: String? {
            status == errSecInteractionNotAllowed
                ? "Loom can't reach its saved sign-in while this iPhone is locked. Unlock it to continue."
                : "Loom couldn't use this iPhone's keychain (error \(status)). Try again."
        }
    }

    let service: String

    init(service: String = "dev.loom.app.ios.credentials") { self.service = service }

    private var item: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "runner"]
    }

    /// Nil when nothing usable is saved. A record from an older trust scheme means sign in again.
    func load() throws -> CredentialRecord? {
        var found: CFTypeRef?
        let status = SecItemCopyMatching(item.merging([kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]) { $1 } as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = found as? Data else { throw Failure(status: status) }
        guard let record = try? JSONDecoder().decode(CredentialRecord.self, from: data), record.isUsable else { return nil }
        return record
    }

    /// Replaces the whole record in one Keychain operation.
    func save(_ record: CredentialRecord) throws {
        let data = try JSONEncoder().encode(record)
        let protection: [CFString: Any] = [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(item as CFDictionary, protection as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(item.merging(protection) { $1 }.merging([kSecAttrSynchronizable: false]) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure(status: status) }
    }

    func clear() throws {
        let status = SecItemDelete(item as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
    }
}

/// This device's sign-in with a runner. The access token lives in memory only. Renewal happens in
/// one place at a time: a refresh token works once, and two renewals racing would look like theft
/// to the runner and end the sign-in.
///
/// Every change of credential goes through `holding`, and a credential is used only once it is on
/// disk. A rotation that cannot be saved yet is held here, unused, and saved before anything else
/// is done with it; a credential nothing will ever use (a sign-in that could not be saved, or a
/// rotation answered after sign-out) is revoked.
actor CloudSession: TokenSource {
    /// Renew this long before the access token would stop working.
    private static let renewMarginMs: Int64 = 60_000

    private enum Holding {
        /// Not read from storage yet, or storage could not be read: ask it again.
        case unread
        case none
        /// Local access has ended, but storage has not acknowledged erasure yet.
        case erasing
        case saved(CredentialRecord)
        /// The runner's live credential, not yet on disk (where an already used token still is).
        case unsaved(CredentialRecord)
    }

    private let store: any CredentialStore
    private let transport: (CredentialRecord) throws -> CredentialTransport
    private let now: () -> Int64
    private var holding = Holding.unread
    private var access: (token: String, expiresAt: Int64)?
    private var renewing: Task<String?, Error>?
    /// Counts sign-ins and sign-outs, so an answer that arrives after one cannot undo it.
    private var generation = 0

    init(
        store: any CredentialStore,
        transport: @escaping (CredentialRecord) throws -> CredentialTransport,
        now: @escaping () -> Int64 = WallClock.nowMs
    ) {
        self.store = store
        self.transport = transport
        self.now = now
    }

    /// The durable credential: read on first use, and saved first if the latest is not on disk yet.
    /// Throws, changing nothing, while storage is unavailable (a locked device), so callers retry.
    private func current() throws -> CredentialRecord? {
        switch holding {
        case .unread:
            let record = try store.load()
            holding = record.map(Holding.saved) ?? .none
            return record
        case .none:
            return nil
        case .erasing:
            try store.clear()
            holding = .none
            return nil
        case .saved(let record):
            return record
        case .unsaved(let record):
            try store.save(record)
            holding = .saved(record)
            return record
        }
    }

    /// The newest credential this device has, saved or not. Only for revoking it.
    private var newest: CredentialRecord? {
        switch holding {
        case .saved(let record), .unsaved(let record): return record
        case .unread: return try? store.load()
        case .none, .erasing: return nil
        }
    }

    /// The saved sign-in, if there is one. Throws while it cannot be read; that is not "none".
    var account: CredentialRecord? {
        get throws { try current() }
    }

    /// A completed sign-in becomes this device's session, once it is saved. If it cannot be saved
    /// it is not used at all, and the runner is told to end it.
    func adopt(_ result: SignInResult) throws {
        generation += 1
        renewing = nil
        do {
            try store.save(result.record)
        } catch {
            revoke(result.record)
            throw error
        }
        holding = .saved(result.record)
        access = (result.accessToken, now() + Int64(result.expiresIn * 1000))
    }

    func accessToken() async throws -> String? {
        guard let record = try current() else { return nil }
        if let access, access.expiresAt - Self.renewMarginMs > now() { return access.token }
        if let renewing { return try await renewing.value }
        let mine = generation
        let task = Task { try await self.renew(record, generation: mine) }
        renewing = task
        defer { if renewing == task { renewing = nil } }
        return try await task.value
    }

    private func renew(_ record: CredentialRecord, generation mine: Int) async throws -> String? {
        let tokens: TokenEndpoint.Tokens
        do {
            tokens = try await TokenEndpoint.request(try transport(record), fields: [("grant_type", "refresh_token"), ("refresh_token", record.refreshToken)])
        } catch SignInError.refused {
            // The runner's own answer: this sign-in is over. An unreachable or unproven runner
            // throws something else, and the saved token stays good for later.
            if mine == generation { try? forget() }
            return nil
        }
        var rotated = record
        rotated.refreshToken = tokens.refreshToken
        guard mine == generation else {
            // Signed out (or in again) while this was in flight: the new token must not outlive that.
            revoke(rotated)
            return nil
        }
        // From here the runner accepts only the rotated token. It is held, and used once saved.
        holding = .unsaved(rotated)
        access = (tokens.accessToken, now() + Int64(tokens.expiresIn * 1000))
        _ = try current()
        return tokens.accessToken
    }

    func invalidateAccess() {
        access = nil
    }

    /// Ends local access immediately. Until erasure succeeds, no saved credential can be used.
    private func forget() throws {
        access = nil
        holding = .erasing
        try store.clear()
        holding = .none
    }

    /// Tells the runner to end a credential this device will never use, over the pinned transport.
    private func revoke(_ record: CredentialRecord) {
        guard let transport = try? transport(record) else { return }
        Task.detached { _ = try? await transport.post(path: "/auth/revoke", fields: [("token", record.refreshToken)]) }
    }

    /// Local access ends first and unconditionally; telling the runner is best effort, and only
    /// ever over the pinned transport. Revoking is what closes this sign-in's connections there.
    func signOut() async throws {
        let previous = newest
        generation += 1
        renewing = nil
        do {
            try forget()
        } catch {
            if let previous { revoke(previous) }
            throw SignInError.unavailable("Loom couldn't finish signing out because this iPhone couldn't remove the saved sign-in. Unlock it and try again before closing Loom.")
        }
        guard let previous, let transport = try? transport(previous) else { return }
        _ = try? await transport.post(path: "/auth/revoke", fields: [("token", previous.refreshToken)])
    }
}
