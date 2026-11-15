import AuthenticationServices
import SwiftUI
import UIKit

@main
struct LoomApp: App {
    @State private var store = AppStore.launch()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .task { await store.start() }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .background: Task { await store.enteredBackground() }
                    case .active: Task { await store.becameActive() }
                    default: break
                    }
                }
        }
    }
}

extension AppStore {
    /// The real app, wired to the Keychain, the system browser and pinned connections.
    static func launch() -> AppStore {
        #if DEBUG
        // Screenshots only: sample data and no connection. There is no such path in a release build.
        if ProcessInfo.processInfo.arguments.contains("-LoomPreview") { return AppStore(previewing: .sample) }
        #endif
        let http = PublicHTTP()
        let checks = TrustChecks(fetch: { url, accept in try await http.get(url, accept: accept) }, now: WallClock.nowMs)
        // Every credential connection starts from a transport proof fetched and verified just now.
        let pinned: (HostOrigin, String) -> PinnedTransport = { origin, domain in
            PinnedTransport(origin: origin, proof: {
                let reply = try await http.get(origin.url("/auth/transport"), accept: "application/json")
                return try await checks.verifyTransport(host: origin.host, trustDomain: domain, proofReply: reply)
            })
        }
        let cloud = CloudSession(store: KeychainCredentialStore(), transport: { record in
            pinned(try HostOrigin(record.origin), record.trustDomain)
        })
        let connection = RunnerConnection(tokens: cloud, open: { bearer in
            guard let record = try? await cloud.account, let origin = try? HostOrigin(record.origin) else { throw SocketOpenError.unreachable }
            return try await pinned(origin, record.trustDomain).openWebSocket(bearer: bearer)
        })
        let browser = BrowserSignIn()
        let exchange = SignInExchange(postProof: { url, fields in try await http.postForm(url, fields: fields) }, checks: checks, pinned: { pinned($0, $1) })
        let signIn = SignInDependencies(
            browse: { url in try await browser.authenticate(url) },
            exchange: { origin, code, attempt, email in try await exchange.run(origin: origin, code: code, attempt: attempt, email: email) }
        )
        return AppStore(session: cloud, connection: connection, signIn: signIn)
    }
}

/// Sign-in happens in the system's authentication session: a real browser the app cannot see
/// into, which hands the callback only to the session that started it.
@MainActor
final class BrowserSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(_ url: URL) async throws -> URL {
        defer { session = nil }
        return try await withCheckedThrowingContinuation { continuation in
            var settled = false
            let finish: (Result<URL, Error>) -> Void = { result in
                guard !settled else { return }
                settled = true
                continuation.resume(with: result)
            }
            let completion: (URL?, Error?) -> Void = { callback, error in
                DispatchQueue.main.async {
                    if let callback {
                        finish(.success(callback))
                    } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        finish(.failure(SignInError.cancelled))
                    } else {
                        finish(.failure(SignInError.unavailable("The browser could not complete the sign-in. Try again.")))
                    }
                }
            }
            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *) {
                session = ASWebAuthenticationSession(url: url, callback: .customScheme(SignInAttempt.callbackScheme), completionHandler: completion)
            } else {
                session = ASWebAuthenticationSession(url: url, callbackURLScheme: SignInAttempt.callbackScheme, completionHandler: completion)
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() { finish(.failure(SignInError.unavailable("The browser could not be opened. Try again."))) }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

/// Asks iOS for a little time to finish something already under way if the scene is suspended.
@MainActor
final class BackgroundWork {
    private var identifier = UIBackgroundTaskIdentifier.invalid

    init(_ name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            Task { @MainActor in self?.end() }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            #if DEBUG
            if NSClassFromString("XCTestCase") != nil {
                // Unit tests borrow this app as their host; it stays out of their way.
                Color.clear
            } else {
                content
            }
            #else
            content
            #endif
        }
        .tint(LoomStyle.ink)
        .background(LoomStyle.canvas.ignoresSafeArea())
        .overlay {
            // The app switcher keeps a picture of the app; it must not be a picture of someone's work.
            if scenePhase != .active && !store.isPreview { PrivacyCover() }
        }
    }

    @ViewBuilder private var content: some View {
        switch store.phase {
        case .launching:
            ProgressView().controlSize(.large)
        case .credentialsUnavailable(let reason):
            ContentUnavailableView {
                Label("Loom is waiting for this iPhone", systemImage: "lock")
            } description: {
                Text(reason)
            } actions: {
                Button("Try again") { Task { await store.start() } }.frame(minHeight: 44)
            }
        case .signedOut:
            SignInView()
        case .signedIn:
            if let scope = store.scope {
                // Keyed to the sign-in: every screen below, with its navigation path and whatever
                // it holds in view state, is rebuilt from nothing for the next one.
                WorkspacesView().environment(scope).id(ObjectIdentifier(scope))
            }
        }
    }
}

private struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: "lock.fill").font(.largeTitle).foregroundStyle(LoomStyle.secondary)
                Text("Loom").font(.title2.weight(.semibold))
            }
        }
        .accessibilityHidden(true)
    }
}

struct PreviewBanner: View {
    var body: some View {
        Text("Preview · Sample data · Not connected")
            .font(.caption)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
            .background(LoomStyle.quiet, ignoresSafeAreaEdges: [])
            .foregroundStyle(LoomStyle.secondary)
            .accessibilityLabel("Preview. Sample data. Not connected.")
            .accessibilityAddTraits(.isHeader)
    }
}
