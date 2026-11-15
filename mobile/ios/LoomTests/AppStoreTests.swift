import XCTest
@testable import Loom

private let project = #"{"id":"p1","name":"loom","repoPath":"/srv/loom","remoteUrl":"https://github.com/acme/loom.git","createdAt":1,"customPromptGeneral":null,"customPromptCodeReview":null,"customPromptFixErrors":null}"#

private func workspace(_ id: String, name: String, bot: String? = nil, archived: Bool = false) -> String {
    let shared = bot.map { #","bot":{"id":"bot1","access":"\#($0)"}"# } ?? ""
    return #"{"id":"\#(id)","projectId":"p1","name":"\#(name)","branch":"loom/\#(name)","worktreePath":"/srv/w/\#(id)","createdAt":2,"archived":\#(archived),"state":"ready","port":null,"initializationFilesCopied":null,"setupLogPath":null,"checkout":"clone","runtime":"container","ownerId":"u1"\#(shared)}"#
}

private func session(_ id: String, workspace: String) -> String {
    #"{"id":"\#(id)","workspaceId":"\#(workspace)","backend":"claude","model":"claude-opus-5-5","effort":"high","title":"Fix build","createdAt":3,"closedAt":null,"forkedFrom":null,"providerSessionId":null}"#
}

/// The store against a real connection and a fake runner: what a person would see and could do.
@MainActor
final class AppStoreTests: XCTestCase {
    private var runner: FakeRunner!
    private var keychain: KeychainCredentialStore!
    private var store: AppStore!
    private var workspaces = Locked("")

    override func setUp() async throws {
        runner = try FakeRunner()
        keychain = KeychainCredentialStore(service: "dev.loom.app.ios.tests.\(UUID().uuidString)")
        try keychain.save(CredentialRecord(origin: "https://loom.example.com", trustDomain: "example.com", email: "developer@example.com", refreshToken: "loom_rt_0"))
        // One good renewal; after that the runner no longer accepts this sign-in.
        let transport = RecordingTransport(replies: [
            HTTPReply(status: 200, body: Data(#"{"access_token":"loom_at_1","refresh_token":"loom_rt_1","expires_in":3600}"#.utf8)),
            HTTPReply(status: 400, body: Data(#"{"error":"invalid_grant","error_description":"This sign-in has ended"}"#.utf8))
        ])
        let cloud = CloudSession(store: keychain, transport: { _ in transport })
        let url = runner.url
        let connection = RunnerConnection(
            tokens: cloud,
            open: { bearer in try await WebSocketChannel.openForTests(url: url, bearer: bearer) },
            callDeadline: 3,
            retryFirst: 0.05
        )
        // A second sign-in, as another person on another host: the browser returns this attempt's
        // own callback, and the exchange yields that account's tokens.
        let signIn = SignInDependencies(
            browse: { url in
                let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value ?? ""
                return URL(string: "\(SignInAttempt.callbackURI)?code=loom_code_b&state=\(state)")!
            },
            exchange: { origin, _, _, email in
                SignInResult(
                    record: CredentialRecord(origin: origin.origin, trustDomain: "example.org", email: email, refreshToken: "loom_rt_b"),
                    accessToken: "loom_at_b",
                    expiresIn: 3600
                )
            }
        )
        store = AppStore(session: cloud, connection: connection, signIn: signIn)

        workspaces = Locked("[\(workspace("w1", name: "mine")),\(workspace("w2", name: "review-bot", bot: "view")),\(workspace("w3", name: "deploy-bot", bot: "control"))]")
        let listed = workspaces
        runner.reply("projects:list", json: "[\(project)]")
        runner.on("workspaces:list") { runner, call in runner.result(call, json: listed.value) }
        runner.reply("sessions:activity", json: #"{"revision":1,"bySession":{"s1":"w1"}}"#)
        runner.reply("sessions:unread", json: "{}")
        runner.reply("workspaces:power", json: #"{"state":"running","error":null}"#)
        runner.reply("sessions:queue", json: "[]")
        runner.reply("sessions:markRead", json: "null")
        runner.on("sessions:list") { runner, call in
            let id = (call.input as? [String: Any])?["workspaceId"] as? String ?? ""
            runner.result(call, json: "[\(session(id == "w1" ? "s1" : "s-\(id)", workspace: id))]")
        }
    }

    override func tearDown() async throws {
        await store.shutdown()
        try keychain.clear()
        runner.stop()
    }

    func testFailedCredentialDeletionDoesNotClaimSignOutCompletedAndCanRetry() async throws {
        let controlled = ControlledStore(keychain)
        let transport = RecordingTransport(replies: [])
        transport.failure = URLError(.notConnectedToInternet)
        let cloud = CloudSession(store: controlled, transport: { _ in transport })
        let connection = RunnerConnection(tokens: cloud, open: { _ in throw SocketOpenError.unreachable })
        let subject = AppStore(session: cloud, connection: connection)
        await subject.start()
        XCTAssertEqual(subject.phase, .signedIn)
        controlled.failClears = errSecInteractionNotAllowed
        await subject.signOut()
        XCTAssertNotNil(try keychain.load(), "the OS has not erased the record")
        XCTAssertNil(subject.scope, "private screens must disappear immediately")
        guard case .credentialsUnavailable(let reason) = subject.phase else {
            return XCTFail("Sign-out must report that erasure is unfinished")
        }
        XCTAssertTrue(reason.contains("signing out"))
        await XCTAssertThrowsAsync(try await cloud.accessToken())
        controlled.failClears = nil
        await subject.start()
        XCTAssertEqual(subject.phase, .signedOut)
        XCTAssertNil(try keychain.load())
        await subject.shutdown()
    }

    /// What the current sign-in holds. Each sign-in has its own.
    private var scope: AccountScope { store.scope! }

    private func signedInAndListed() async {
        await store.start()
        await waitUntil(message: "inventory") { self.store.scope?.projects.count == 1 && self.store.scope?.workspaces(in: "p1").count == 3 }
    }

    private func eventsAfter(_ replies: [Int: String]) {
        runner.on("sessions:eventsAfter") { runner, call in
            let after = (call.input as? [String: Any])?["afterSeq"] as? Int ?? -1
            runner.result(call, json: replies[after] ?? "[]")
        }
    }

    func testInventoryComesFromTheRunnerWithExplicitSharedAccess() async throws {
        await signedInAndListed()
        XCTAssertEqual(store.phase, .signedIn)
        XCTAssertEqual(store.connection, .connected)
        XCTAssertEqual(store.account?.email, "developer@example.com")
        XCTAssertEqual(scope.projects.map(\.name), ["loom"])
        let rows = scope.workspaces(in: "p1")
        XCTAssertEqual(rows.map(\.name), ["mine", "review-bot", "deploy-bot"])
        XCTAssertEqual(rows.map(\.sharedAccess), [nil, .view, .control])
        XCTAssertEqual(rows.map { scope.canControl($0.id) }, [true, false, true])
        XCTAssertEqual(runner.frames(for: "workspaces:list").first?["input"] as? [String: String], ["projectId": "p1"])
        XCTAssertTrue(scope.isRunning(sessionId: "s1"))

        // The connection asked only for channels a mobile sign-in is allowed to call.
        let allowed: Set<String> = [
            "app:ping", "projects:list", "workspaces:list", "workspaces:power", "workspaces:start", "workspaces:stop",
            "sessions:list", "sessions:activity", "sessions:unread", "sessions:markRead", "sessions:eventsAfter",
            "sessions:send", "sessions:cancel", "sessions:answerQuestion", "sessions:queue", "files:listDir",
            "files:read", "git:status", "git:diff"
        ]
        XCTAssertTrue(Set(runner.frames.compactMap { $0["channel"] as? String }).isSubset(of: allowed))
    }

    func testViewOnlyWorkspaceRefusesEveryControlActionLocally() async throws {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w2")
        scope.setDraft("s-w2", "please deploy")
        await scope.sendDraft(sessionId: "s-w2")
        await scope.cancelTurn(sessionId: "s-w2")
        await scope.setPower(workspaceId: "w2", running: false)
        await scope.answer(sessionId: "s-w2", requestId: "q1", answers: ["ok": ["Allow"]])
        try await Task.sleep(nanoseconds: 200_000_000)
        for channel in ["sessions:send", "sessions:cancel", "workspaces:stop", "workspaces:start", "sessions:answerQuestion"] {
            XCTAssertTrue(runner.frames(for: channel).isEmpty, channel)
        }
        XCTAssertEqual(scope.draft("s-w2").text, "please deploy")
    }

    func testFailedSendKeepsTheDraftAndItsIdentityForTheRetry() async throws {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w1")
        let attempts = Locked(0)
        runner.on("sessions:send") { runner, call in
            if attempts.update({ $0 += 1; return $0 }) == 1 { runner.fail(call, "The workspace is stopped") } else { runner.result(call) }
        }
        scope.setDraft("s1", "Run the tests again")
        await scope.sendDraft(sessionId: "s1")
        XCTAssertEqual(scope.draft("s1").text, "Run the tests again", "a failed message stays in the composer")
        XCTAssertEqual(scope.draft("s1").error, "The workspace is stopped")
        XCTAssertFalse(scope.draft("s1").isSending)

        await scope.sendDraft(sessionId: "s1")
        XCTAssertEqual(scope.draft("s1").text, "")
        XCTAssertNil(scope.draft("s1").error)
        let inputs = runner.frames(for: "sessions:send").compactMap { $0["input"] as? [String: Any] }
        XCTAssertEqual(inputs.count, 2)
        let first = try XCTUnwrap(inputs[0]["messageId"] as? String)
        XCTAssertNotNil(UUID(uuidString: first))
        XCTAssertEqual(inputs[1]["messageId"] as? String, first, "the retry is the same message, so the runner runs it once")
        XCTAssertEqual(inputs[0]["text"] as? String, "Run the tests again")
        XCTAssertEqual(inputs[0]["sessionId"] as? String, "s1")
        XCTAssertEqual((inputs[0]["attachments"] as? [Any])?.count, 0)

        // A different message is a different identity.
        scope.setDraft("s1", "And lint")
        await scope.sendDraft(sessionId: "s1")
        let third = runner.frames(for: "sessions:send").compactMap { $0["input"] as? [String: Any] }.last?["messageId"] as? String
        XCTAssertNotEqual(third, first)
    }

    func testTranscriptFillsGapsBeforeShowingLaterEvents() async throws {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w1")
        eventsAfter([
            0: #"[{"seq":1,"event":{"type":"user.text","turnId":"t1","text":"Fix it"}},{"seq":2,"event":{"type":"text.delta","turnId":"t1","text":"On "}}]"#,
            2: #"[{"seq":3,"event":{"type":"text.delta","turnId":"t1","text":"it"}},{"seq":4,"event":{"type":"text.done","turnId":"t1","text":"On it."}}]"#
        ])
        await scope.openSession("s1")
        XCTAssertEqual(scope.timeline("s1")?.cursor, 2)

        // Event 3 never arrived; 4 shows up live. The store must fetch what it missed.
        runner.push("session:event", json: #"{"workspaceId":"w1","sessionId":"s1","seq":4,"event":{"type":"text.done","turnId":"t1","text":"On it."}}"#)
        await waitUntil(message: "gap filled") { self.scope.timeline("s1")?.cursor == 4 }
        XCTAssertEqual(runner.frames(for: "sessions:eventsAfter").compactMap { ($0["input"] as? [String: Any])?["afterSeq"] as? Int }, [0, 2])
        let texts = scope.timeline("s1")?.transcript.blocks.compactMap { block -> String? in
            if case .assistant(let text) = block.content { return text } else { return nil }
        }
        XCTAssertEqual(texts, ["On it."])

        // Events for a conversation that is not open are not kept.
        runner.push("session:event", json: #"{"workspaceId":"w3","sessionId":"s-w3","seq":1,"event":{"type":"user.text","turnId":"t9","text":"secret plan"}}"#)
        runner.push("session:activity", json: #"{"revision":2,"bySession":{}}"#)
        await waitUntil(message: "activity push") { !self.scope.isRunning(sessionId: "s1") }
        XCTAssertNil(scope.timeline("s-w3"))
    }

    func testAnsweringAQuestionSendsOnceAndWaitsForTheRunnerToCloseIt() async throws {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w1")
        eventsAfter([0: #"[{"seq":1,"event":{"type":"question.requested","requestId":"q1","turnId":"t1","blocking":true,"questions":[{"id":"token","header":"Access","question":"Deploy token?","isSecret":true}]}}]"#])
        runner.reply("sessions:answerQuestion", json: "null")
        await scope.openSession("s1")

        let sent = await scope.answer(sessionId: "s1", requestId: "q1", answers: ["token": ["s3cr3t"]])
        XCTAssertTrue(sent)
        let input = try XCTUnwrap(runner.frames(for: "sessions:answerQuestion").first?["input"] as? [String: Any])
        XCTAssertEqual(input["sessionId"] as? String, "s1")
        let answer = try XCTUnwrap(input["answer"] as? [String: Any])
        XCTAssertEqual(answer["requestId"] as? String, "q1")
        XCTAssertEqual(answer["answers"] as? [String: [String]], ["token": ["s3cr3t"]])

        runner.push("session:event", json: #"{"workspaceId":"w1","sessionId":"s1","seq":2,"event":{"type":"question.answered","requestId":"q1","turnId":"t1","answers":{"token":["[hidden]"]}}}"#)
        await waitUntil(message: "answered") {
            guard case .question(let question)? = self.scope.timeline("s1")?.transcript.blocks.first?.content else { return false }
            return self.scope.timeline("s1")?.transcript.state(of: question) == .answered
        }
        XCTAssertFalse(String(describing: scope.timeline("s1")).contains("s3cr3t"))
    }

    func testLosingAccessEvictsWhatIsNoLongerVisible() async throws {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w3")
        eventsAfter([0: #"[{"seq":1,"event":{"type":"user.text","turnId":"t1","text":"deploy"}}]"#])
        await scope.openSession("s-w3")
        scope.setDraft("s-w3", "half-written")
        XCTAssertNotNil(scope.timeline("s-w3"))

        workspaces.update { $0 = "[\(workspace("w1", name: "mine"))]" }
        runner.push("bots:changed", json: #"{"botId":"bot1","accessChanged":true}"#)
        await waitUntil(message: "eviction") { self.scope.workspaces(in: "p1").count == 1 }
        XCTAssertNil(scope.timeline("s-w3"))
        XCTAssertTrue(scope.sessions(in: "w3").isEmpty)
        XCTAssertEqual(scope.draft("s-w3").text, "")
        XCTAssertEqual(scope.workspaces(in: "p1").map(\.id), ["w1"])
    }

    func testSignOutPurgesMemoryAndTheKeychain() async throws {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w1")
        eventsAfter([0: #"[{"seq":1,"event":{"type":"user.text","turnId":"t1","text":"private"}}]"#])
        await scope.openSession("s1")
        scope.setDraft("s1", "unsent")
        let ended = scope

        await store.signOut()
        XCTAssertEqual(store.phase, .signedOut)
        XCTAssertNil(store.account)
        XCTAssertNil(store.scope, "every row, conversation and draft goes with the sign-in")
        XCTAssertNil(try keychain.load())
        await waitUntil(message: "socket closed") { self.store.connection == .idle || self.store.connection == .signedOut }

        // Whatever still holds the ended scope can no longer reach the runner through it.
        let calls = runner.calls.count
        await XCTAssertThrowsAsync(try await ended.listDirectory(workspaceId: "w1", path: ""))
        await ended.refreshInventory()
        await ended.openSession("s1")
        XCTAssertEqual(runner.calls.count, calls)
    }

    // MARK: Lifetime of private data

    /// Replies are not ordered across calls. A listing that was asked for before a grant was
    /// revoked, and answered after the revocation was applied, must not bring the workspace back.
    func testListingFromBeforeARevocationCannotResurrectTheWorkspace() async throws {
        await signedInAndListed()
        let before = workspaces.value
        let stalled = Locked<FakeRunner.Call?>(nil)
        let listed = workspaces
        runner.on("workspaces:list") { runner, call in
            if stalled.value == nil { stalled.update { $0 = call } } else { runner.result(call, json: listed.value) }
        }
        let older = Task { await self.scope.refreshInventory() }
        await waitUntil(message: "older listing in flight") { stalled.value != nil }

        workspaces.update { $0 = "[\(workspace("w1", name: "mine"))]" }
        runner.push("bots:changed", json: #"{"botId":"bot1","accessChanged":true}"#)
        try await Task.sleep(nanoseconds: 400_000_000)
        runner.result(try XCTUnwrap(stalled.value), json: before)
        await older.value

        await waitUntil(message: "the latest listing wins") { self.scope.workspaces(in: "p1").map(\.id) == ["w1"] }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(scope.workspaces(in: "p1").map(\.id), ["w1"])
        XCTAssertNil(scope.workspace("w3"))
    }

    /// Actions in flight at sign-out fail with the closed connection. Their outcome belongs to the
    /// ended sign-in: the next person, on another host, sees none of it, even where the request
    /// and session identifiers collide.
    func testOutcomeOfAnActionInFlightAtSignOutNeverReachesTheNextSignIn() async throws {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w1")
        eventsAfter([0: #"[{"seq":1,"event":{"type":"question.requested","requestId":"q1","turnId":"t1","blocking":true,"questions":[{"id":"a","header":"","question":"Proceed?","options":[{"label":"Yes","description":""}]}]}}]"#])
        runner.on("sessions:answerQuestion") { _, _ in }
        runner.on("sessions:cancel") { _, _ in }
        runner.on("sessions:list") { runner, call in
            let id = (call.input as? [String: Any])?["workspaceId"] as? String ?? ""
            if id == "w1", runner.frames(for: "sessions:list").count > 1 { return }
            runner.result(call, json: "[\(session(id == "w1" ? "s1" : "s-\(id)", workspace: id))]")
        }
        await scope.openSession("s1")
        let first = scope
        let answering = Task { await first.answer(sessionId: "s1", requestId: "q1", answers: ["a": ["Yes"]]) }
        let cancelling = Task { await first.cancelTurn(sessionId: "s1") }
        let listing = Task { await first.loadSessions(workspaceId: "w1") }
        await waitUntil(message: "all in flight") {
            self.runner.frames(for: "sessions:answerQuestion").count == 1 && self.runner.frames(for: "sessions:cancel").count == 1
                && self.runner.frames(for: "sessions:list").count == 2
        }

        await store.signOut()
        store.signIn(email: "other@example.org", host: "loom.example.org")
        await waitUntil(message: "second sign-in listed") {
            self.store.phase == .signedIn && self.store.scope?.workspaces(in: "p1").count == 3
        }
        _ = await answering.value
        await cancelling.value
        await listing.value

        XCTAssertEqual(store.account, Account(email: "other@example.org", origin: "https://loom.example.org", trustDomain: "example.org"))
        XCTAssertFalse(scope === first)
        XCTAssertNil(scope.actionError("question:q1"))
        XCTAssertNil(scope.actionError("cancel:s1"))
        XCTAssertNil(scope.sessionsError(in: "w1"))
        XCTAssertNil(scope.timeline("s1"), "nothing the first person opened is open for the second")
        XCTAssertEqual(try keychain.load()?.refreshToken, "loom_rt_b")
    }

    // MARK: Question answers

    private func openQuestion() async {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w1")
        eventsAfter([0: #"[{"seq":1,"event":{"type":"question.requested","requestId":"q1","turnId":"t1","blocking":true,"questions":[{"id":"env","header":"","question":"Where?","options":[{"label":"Sandbox","description":""},{"label":"Staging","description":""}],"isOther":true,"multiSelect":true},{"id":"key","header":"","question":"Key?","isSecret":true}]}}]"#])
        await scope.openSession("s1")
    }

    private func request(_ requestId: String) throws -> QuestionRequest {
        for block in scope.timeline("s1")?.transcript.blocks ?? [] {
            if case .question(let question) = block.content, question.request.requestId == requestId { return question.request }
        }
        throw XCTSkip("no question \(requestId)")
    }

    /// A card scrolled out of a lazy transcript is rebuilt from what the scope kept: ordinary
    /// answers survive, secret ones never reach the scope at all.
    func testTypedAnswersOutliveTheCardButNeverTheirSecrets() async throws {
        await openQuestion()
        var form = QuestionForm(request: try request("q1"))
        form.toggle("env", .option(1))
        form.toggle("env", .other)
        form.setText("env", "Preview")
        form.setText("key", "s3cr3t")
        scope.keepQuestionForm(sessionId: "s1", form)

        let rebuilt = scope.questionForm(try request("q1"))
        XCTAssertEqual(rebuilt.answers["env"], ["Staging", "Preview"])
        XCTAssertEqual(rebuilt.text("key"), "")
        XCTAssertFalse(String(describing: scope.questionForm(try request("q1"))).contains("s3cr3t"))

        // Closed by the runner: what was typed for it goes too.
        runner.push("session:event", json: #"{"workspaceId":"w1","sessionId":"s1","seq":2,"event":{"type":"question.resolved","requestId":"q1","turnId":"t1"}}"#)
        await waitUntil(message: "resolved") { self.scope.timeline("s1")?.transcript.state(ofRequest: "q1") == .closed }
        XCTAssertEqual(scope.questionForm(try request("q1")).answers["env"], [])
        scope.keepQuestionForm(sessionId: "s1", form)
        XCTAssertEqual(scope.questionForm(try request("q1")).answers["env"], [], "nothing is kept for a closed question")
    }

    func testAnAcceptedAnswerIsSentOnceAndClearsWhatWasTyped() async throws {
        await openQuestion()
        runner.reply("sessions:answerQuestion", json: "null")
        var form = QuestionForm(request: try request("q1"))
        form.toggle("env", .option(0))
        form.setText("key", "s3cr3t")
        scope.keepQuestionForm(sessionId: "s1", form)

        let sent = await scope.answer(sessionId: "s1", requestId: "q1", answers: form.answers)
        XCTAssertTrue(sent)
        XCTAssertTrue(scope.isAnswerSent("q1"))
        XCTAssertEqual(scope.questionForm(try request("q1")).answers["env"], [])
        let again = await scope.answer(sessionId: "s1", requestId: "q1", answers: form.answers)
        XCTAssertFalse(again, "a rebuilt card cannot send the same answer twice")
        XCTAssertEqual(runner.frames(for: "sessions:answerQuestion").count, 1)
    }

    func testRevokedWorkspaceTakesItsTypedAnswersAlong() async throws {
        workspaces.update { $0 = "[\(workspace("w1", name: "mine", bot: "control"))]" }
        await store.start()
        await waitUntil(message: "inventory") { self.store.scope?.workspaces(in: "p1").count == 1 }
        await scope.loadSessions(workspaceId: "w1")
        eventsAfter([0: #"[{"seq":1,"event":{"type":"question.requested","requestId":"q1","turnId":"t1","blocking":true,"questions":[{"id":"env","header":"","question":"Where?"}]}}]"#])
        await scope.openSession("s1")
        var form = QuestionForm(request: try request("q1"))
        form.setText("env", "production plan")
        scope.keepQuestionForm(sessionId: "s1", form)

        workspaces.update { $0 = "[]" }
        runner.push("bots:changed", json: #"{"botId":"bot1","accessChanged":true}"#)
        await waitUntil(message: "evicted") { self.scope.workspace("w1") == nil }
        XCTAssertNil(scope.timeline("s1"))
        let blank = QuestionForm(request: form.request)
        XCTAssertEqual(scope.questionForm(form.request), blank)
    }

    // MARK: Screens of a revoked workspace

    /// The screen for a workspace route owns its loaded file text and diffs in view state. When
    /// the workspace is revoked, that state must be released, not kept behind a notice.
    func testScreensOfARevokedWorkspaceReleaseTheirOwnState() async throws {
        await signedInAndListed()
        let hosted = try HostedWindow(
            WorkspaceScoped(route: .file(workspaceId: "w3", path: "deploy.sh")) { LifetimeProbe() }.environment(scope).environment(store)
        )
        await hosted.settle()
        XCTAssertEqual(LifetimeProbe.Witness.alive.value, 1)

        workspaces.update { $0 = "[\(workspace("w1", name: "mine")),\(workspace("w2", name: "review-bot", bot: "view"))]" }
        runner.push("bots:changed", json: #"{"botId":"bot1","accessChanged":true}"#)
        await waitUntil(message: "evicted") { self.scope.workspace("w3") == nil }
        await hosted.settle()
        XCTAssertEqual(LifetimeProbe.Witness.alive.value, 0, "the screen's own state went with the workspace")
        hosted.close()
    }

    /// A Keychain that cannot be read at launch (a locked device) is not a missing sign-in.
    func testUnreadableKeychainAtLaunchIsRetriedNotTreatedAsSignedOut() async throws {
        await store.shutdown()
        let controlled = ControlledStore(keychain)
        controlled.failLoads = errSecInteractionNotAllowed
        let transport = RecordingTransport(replies: [
            HTTPReply(status: 200, body: Data(#"{"access_token":"loom_at_1","refresh_token":"loom_rt_1","expires_in":3600}"#.utf8))
        ])
        let cloud = CloudSession(store: controlled, transport: { _ in transport })
        let url = runner.url
        store = AppStore(session: cloud, connection: RunnerConnection(
            tokens: cloud,
            open: { bearer in try await WebSocketChannel.openForTests(url: url, bearer: bearer) },
            callDeadline: 3,
            retryFirst: 0.05
        ))
        await store.start()
        XCTAssertNotEqual(store.phase, .signedOut, "the sign-in screen would invite replacing a sign-in that still exists")
        XCTAssertEqual(store.phase, .credentialsUnavailable(KeychainCredentialStore.Failure(status: errSecInteractionNotAllowed).errorDescription!))
        XCTAssertNotNil(try keychain.load())
        XCTAssertEqual(runner.connectionCount, 0)

        controlled.failLoads = nil
        await store.becameActive()
        await waitUntil(message: "signed in once readable") { self.store.phase == .signedIn && self.store.connection == .connected }
    }

    func testRunnerEndingTheSignInPurgesToo() async throws {
        await signedInAndListed()
        await scope.loadSessions(workspaceId: "w1")
        runner.closeAfterHello = 4401
        runner.closeAll(code: 4401)
        await waitUntil(message: "signed out") { self.store.phase == .signedOut }
        XCTAssertNil(store.scope)
        XCTAssertNil(try keychain.load())
        XCTAssertNotNil(store.notice, "the person is told why they are back at sign-in")
    }
}
