import Foundation
import Observation

struct Account: Equatable {
    let email: String
    let origin: String
    let trustDomain: String
}

enum SignInStatus: Equatable {
    case idle
    case working(String)
    case failed(String)
}

/// What sign-in needs from the outside world: the system browser and the code exchange.
struct SignInDependencies {
    /// Opens the address in the system authentication session and returns the callback it came back with.
    var browse: @MainActor (URL) async throws -> URL
    /// Turns the browser's code into a verified sign-in (`SignInExchange.run` in the app).
    var exchange: (_ origin: HostOrigin, _ code: String, _ attempt: SignInAttempt, _ email: String) async throws -> SignInResult
}

/// The root that native screens observe: whether someone is signed in, the connection, and the
/// sign-in flow. Everything private to a sign-in lives in its `scope`, which is replaced, never
/// emptied, so nothing still in flight for an ended sign-in can reach what is shown next.
@MainActor
@Observable
final class AppStore {
    enum Phase: Equatable {
        case launching
        /// A saved sign-in may exist but cannot be read now (a locked device). Retried, never erased.
        case credentialsUnavailable(String)
        case signedOut
        case signedIn
    }

    private(set) var phase = Phase.launching
    private(set) var account: Account?
    private(set) var connection = ConnectionState.idle
    private(set) var signInStatus = SignInStatus.idle
    /// Something the person should read once, such as why they are back at sign-in.
    var notice: String?
    /// Present exactly while signed in.
    private(set) var scope: AccountScope?

    /// True for the DEBUG screenshot mode: sample data, no connection, no sign-in.
    let isPreview: Bool

    @ObservationIgnored private let session: CloudSession?
    @ObservationIgnored private let runner: RunnerConnection?
    @ObservationIgnored private let signInDependencies: SignInDependencies?
    @ObservationIgnored private var listening: Task<Void, Never>?
    @ObservationIgnored private var signingIn: Task<Void, Never>?

    init(session: CloudSession, connection: RunnerConnection, signIn: SignInDependencies? = nil) {
        self.session = session
        runner = connection
        signInDependencies = signIn
        isPreview = false
    }

    #if DEBUG
    /// The disconnected preview. It has no session and no connection, so nothing here can reach a host.
    init(previewing data: PreviewData) {
        session = nil
        runner = nil
        signInDependencies = nil
        isPreview = true
        phase = .signedIn
        account = data.account
        connection = .connected
        scope = AccountScope(previewing: data)
    }
    #endif

    private func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Try again."
    }

    // MARK: Lifecycle

    /// Reads the saved sign-in and starts following the connection. Called again to retry while
    /// the saved sign-in cannot be read.
    func start() async {
        guard let session, let runner else { return }
        switch phase {
        case .launching, .credentialsUnavailable: break
        case .signedOut, .signedIn: return
        }
        if listening == nil {
            listening = Task { [weak self] in
                for await event in runner.events { await self?.handle(event) }
            }
        }
        do {
            guard let record = try await session.account else {
                phase = .signedOut
                return
            }
            begin(record)
            await runner.resume()
        } catch {
            phase = .credentialsUnavailable(describe(error))
        }
    }

    func shutdown() async {
        listening?.cancel()
        signingIn?.cancel()
        scope?.end()
        await runner?.shutdown()
    }

    /// Background: the socket closes. A sign-in in the browser is deliberately left alone.
    func enteredBackground() async {
        await runner?.suspend()
    }

    /// Foreground: reconnect, which reloads everything this person may currently see. Unlocking
    /// the device is also what makes an unreadable saved sign-in readable again.
    func becameActive() async {
        if case .credentialsUnavailable = phase { return await start() }
        guard phase == .signedIn else { return }
        await runner?.resume()
    }

    func retryConnection() async {
        guard phase == .signedIn else { return }
        await runner?.reconnectNow()
    }

    private func handle(_ event: RunnerEvent) async {
        switch event {
        case .state(let state):
            connection = state
            scope?.connection = state
            switch state {
            case .connected:
                await scope?.connected()
            case .signedOut:
                if phase == .signedIn { await endSignIn(notice: "Your sign-in to this organization has ended. Sign in again to continue.") }
            default:
                break
            }
        case .push(let channel, let frame):
            scope?.receive(channel, frame)
        }
    }

    /// A sign-in begins with a scope of its own.
    private func begin(_ record: CredentialRecord) {
        guard let runner else { return }
        account = Account(email: record.email, origin: record.origin, trustDomain: record.trustDomain)
        scope = AccountScope(runner: runner, connection: connection)
        signInStatus = .idle
        phase = .signedIn
    }

    /// Ends the sign-in's scope: every conversation, file listing, draft and row goes with it.
    private func leave() {
        scope?.end()
        scope = nil
        account = nil
        signInStatus = .idle
        phase = .signedOut
    }

    // MARK: Signing in and out

    /// Starts a sign-in with the email and host the person typed. Both are typed every time:
    /// the email is what the Google identity is checked against, so it is never filled in for them.
    func signIn(email: String, host: String) {
        guard phase == .signedOut, signingIn == nil, let session, let runner, let dependencies = signInDependencies else { return }
        notice = nil
        let typed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard typed.contains("@"), !typed.hasPrefix("@"), !typed.hasSuffix("@") else {
            signInStatus = .failed("Enter your work email address.")
            return
        }
        let origin: HostOrigin
        do {
            origin = try HostOrigin(host)
        } catch {
            signInStatus = .failed(describe(error))
            return
        }
        signInStatus = .working("Waiting for you to finish in the browser…")
        signingIn = Task { [weak self] in
            // Finishing the exchange matters more than the scene staying active: the one-time
            // code lives for a minute, and the person may be returning from another app.
            let background = BackgroundWork("Finish sign-in")
            defer { background.end() }
            do {
                let attempt = SignInAttempt()
                let callback = try await dependencies.browse(attempt.startURL(origin: origin))
                let code = try attempt.redeem(callback: callback.absoluteString)
                self?.signInStatus = .working("Verifying your organization's host…")
                let result = try await dependencies.exchange(origin, code, attempt, typed)
                try await session.adopt(result)
                guard let self else { return }
                self.begin(result.record)
                await runner.resume()
            } catch SignInError.cancelled {
                self?.signInStatus = .idle
            } catch {
                self?.signInStatus = .failed(self?.describe(error) ?? "")
            }
            self?.signingIn = nil
        }
    }

    /// Ends this device's access now, then tells the runner, which closes this sign-in's connections.
    func signOut() async {
        guard phase == .signedIn else { return }
        leave()
        await runner?.suspend()
        await eraseSignIn()
    }

    /// The runner ended the sign-in (revoked, removed, or expired beyond renewal).
    private func endSignIn(notice: String) async {
        leave()
        self.notice = notice
        await eraseSignIn()
    }

    private func eraseSignIn() async {
        do { try await session?.signOut() }
        catch { phase = .credentialsUnavailable(describe(error)) }
    }
}
