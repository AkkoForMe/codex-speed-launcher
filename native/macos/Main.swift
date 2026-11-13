import AppKit
import Foundation

struct BridgeHello: Decodable { let endpoint: String; let token: String }
struct TestStats: Decodable { let inspections: Int; let launches: Int; let closes: Int; let forcedStops: Int }
struct LauncherState: Decodable {
    let version: String
    let model: String
    let phase: String
    let status: String
    let detail: String
    let busy: Bool
    let compatible: Bool
    let externalRunning: Bool
    let managed: Bool
    let closed: Bool
    let selfTestStats: TestStats?
}

// Diagnostics exist only for the explicit credential-free native self-test.
// A background watchdog also covers AppKit startup before its run loop starts.
final class SelfTestProgress {
    let report: URL
    private let lock = NSLock()
    private var finished = false
    private var phase = "native-main"
    init(report: URL) {
        self.report = report
        mark("native-main")
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 35) { [self] in
            lock.lock(); let done = finished; let stage = phase; lock.unlock()
            guard !done else { return }
            let result: [String: Any] = ["ok": false, "mockOnly": true, "phase": stage,
                "error": "Native self-test watchdog timed out.", "realCodexStarted": false, "realApiRequests": 0]
            if let bytes = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
                try? bytes.write(to: report)
            }
            fputs("Native self-test timed out at: \(stage)\n", stderr)
            exit(1)
        }
    }
    func mark(_ value: String) {
        lock.lock(); phase = value; lock.unlock()
        let line = "\(Date().timeIntervalSince1970) \(value)\n"
        fputs(line, stderr)
        try? FileManager.default.createDirectory(at: report.deletingLastPathComponent(), withIntermediateDirectories: true)
        let file = report.deletingLastPathComponent().appendingPathComponent("progress.log")
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd(); try? handle.write(contentsOf: Data(line.utf8))
        }
    }
    func finish() { lock.lock(); finished = true; lock.unlock() }
}

// AppKit owns the visible application. Node is a private child providing the
// same controller, ownership checks and authenticated bridge as Windows.
final class LauncherApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let status = NSTextField(labelWithString: "正在检查 Codex…")
    let version = NSTextField(labelWithString: "—")
    let model = NSTextField(labelWithString: "未读取")
    let detail = NSTextField(wrappingLabelWithString: "")
    let footer = NSTextField(labelWithString: "Standard / Fast · 保留现有连接与模型")
    let dot = NSView()
    let primary = NSButton(title: "启动 Codex", target: nil, action: nil)
    let refresh = NSButton(title: "刷新状态", target: nil, action: nil)
    let quit = NSButton(title: "退出启动器", target: nil, action: nil)
    var backend: Process?
    var parentInput: Pipe?
    var privateOutput: Pipe?
    var helloBuffer = Data()
    var bridge: URL?
    var credential: String?
    var state: LauncherState?
    var timer: Timer?
    var pollPending = false
    var actionPending = false
    var connectionFailed = false
    var finishing = false
    var allowTermination = false
    var confirmationOverride: Bool?
    let selfTestReport: URL?
    let testProgress: SelfTestProgress?
    let launcherRoot: URL
    var testStep = 0
    var testChecks: [String] = []
    var testComplete = false
    var testLayout: [String: Double] = [:]
    let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 4
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config)
    }()

    init(root: URL, report: URL?, progress: SelfTestProgress?) {
        launcherRoot = root; selfTestReport = report; testProgress = progress; super.init()
    }

    func label(_ text: String, size: CGFloat = 12, color: NSColor = .secondaryLabelColor) -> NSTextField {
        let result = NSTextField(labelWithString: text)
        result.font = .systemFont(ofSize: size)
        result.textColor = color
        return result
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        testProgress?.mark("applicationDidFinishLaunching")
        makeWindow()
        startBackend()
        if selfTestReport != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                guard let self = self, !self.testComplete else { return }
                self.failTest("Timed out waiting for the native-window self-test.")
            }
        }
    }

    func makeWindow() {
        testProgress?.mark("makeWindow.begin")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 426, height: 486),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Codex Speed Launcher"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.backgroundColor = NSColor(calibratedRed: 0.96, green: 0.965, blue: 0.974, alpha: 1)
        window.appearance = NSAppearance(named: .aqua)
        testProgress?.mark("makeWindow.created")
        let content = window.contentView!
        let stack = NSStackView()
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 26),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -26),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
        ])
        let heading = NSStackView(views: [label("CODEX SPEED", size: 11), label("Codex 启动器", size: 23, color: .labelColor)])
        heading.orientation = .vertical; heading.alignment = .leading; heading.spacing = 6
        stack.addArrangedSubview(heading)
        let card = NSView(); card.wantsLayer = true; card.layer?.backgroundColor = NSColor.white.cgColor
        card.layer?.cornerRadius = 13; card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor(calibratedWhite: 0.9, alpha: 1).cgColor
        stack.addArrangedSubview(card)
        let cardStack = NSStackView(); cardStack.orientation = .vertical; cardStack.alignment = .leading; cardStack.spacing = 14
        cardStack.translatesAutoresizingMaskIntoConstraints = false; card.addSubview(cardStack)
        NSLayoutConstraint.activate([
            card.widthAnchor.constraint(equalTo: stack.widthAnchor),
            cardStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            cardStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -18),
            cardStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 17),
            cardStack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -17),
        ])
        dot.wantsLayer = true; dot.layer?.cornerRadius = 4; dot.layer?.backgroundColor = NSColor.systemGray.cgColor
        NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 8), dot.heightAnchor.constraint(equalToConstant: 8)])
        status.font = .systemFont(ofSize: 14, weight: .semibold)
        status.lineBreakMode = .byTruncatingTail
        let statusRow = NSStackView(views: [dot, status]); statusRow.orientation = .horizontal; statusRow.spacing = 8
        cardStack.addArrangedSubview(statusRow)
        for (name, value) in [("Codex 版本", version), ("配置模型", model)] {
            value.font = .systemFont(ofSize: 12); value.alignment = .right; value.lineBreakMode = .byTruncatingMiddle
            value.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let row = NSStackView(views: [label(name, size: 11), NSView(), value]); row.orientation = .horizontal
            cardStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: cardStack.widthAnchor).isActive = true
        }
        for button in [primary, refresh, quit] {
            button.bezelStyle = .rounded; button.controlSize = .large
            button.font = .systemFont(ofSize: 13); button.target = self
            button.heightAnchor.constraint(equalToConstant: 42).isActive = true
        }
        primary.bezelColor = .systemBlue; primary.contentTintColor = .white
        primary.action = #selector(primaryClicked); primary.isEnabled = false
        stack.addArrangedSubview(primary)
        primary.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        refresh.action = #selector(refreshClicked); refresh.isEnabled = false
        quit.action = #selector(quitClicked)
        let buttons = NSStackView(views: [refresh, quit]); buttons.orientation = .horizontal
        buttons.spacing = 10; buttons.distribution = .fillEqually
        stack.addArrangedSubview(buttons)
        buttons.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        detail.font = .systemFont(ofSize: 11); detail.textColor = .secondaryLabelColor
        detail.maximumNumberOfLines = 5
        stack.addArrangedSubview(detail)
        detail.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        footer.font = .systemFont(ofSize: 10); footer.textColor = .secondaryLabelColor
        footer.alignment = .center; footer.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(footer)
        NSLayoutConstraint.activate([
            footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            footer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
        ])
        let menu = NSMenu(); let menuItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 Codex Speed Launcher", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menuItem.submenu = appMenu; menu.addItem(menuItem); NSApp.mainMenu = menu
        testProgress?.mark("makeWindow.before-show")
        window.center(); window.makeKeyAndOrderFront(nil)
        testProgress?.mark("makeWindow.before-activate")
        NSApp.activate(ignoringOtherApps: true)
        testProgress?.mark("makeWindow.complete")
    }

    func startBackend() {
        testProgress?.mark("startBackend.begin")
        let node = launcherRoot.appendingPathComponent("runtime/node")
        let script = launcherRoot.appendingPathComponent("src/gui-macos-backend.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: script.path) else {
            showFailure("启动器文件不完整。请重新解压完整的 Mac 应用包。"); return
        }
        let process = Process(); let output = Pipe(); let input = Pipe()
        process.executableURL = node
        process.arguments = [script.path] + (selfTestReport == nil ? [] : ["--self-test"])
        process.currentDirectoryURL = launcherRoot
        process.standardInput = input; process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        // Avoid loading a global Node preload or runtime option into this
        // credential-free local controller. Preserve CODEX_HOME intentionally.
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "NODE_OPTIONS"); env.removeValue(forKey: "NODE_PATH")
        process.environment = env
        backend = process; parentInput = input; privateOutput = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.receiveHello(data) }
        }
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
            guard let self = self else { return }
            if self.finishing { self.exitNow() }
            else { self.showFailure("启动器后台已退出。请先保存工作并退出本次 Codex，再重新打开启动器。") }
        } }
        do { try process.run(); testProgress?.mark("startBackend.running") }
        catch { showFailure("无法启动内置运行时。请重新下载与本机芯片匹配的完整应用包。") }
    }

    func receiveHello(_ data: Data) {
        guard bridge == nil, !data.isEmpty else { return }
        helloBuffer.append(data)
        guard helloBuffer.count <= 4096 else { showFailure("启动器后台握手失败。"); return }
        guard let newline = helloBuffer.firstIndex(of: 10) else { return }
        do {
            let hello = try JSONDecoder().decode(BridgeHello.self, from: helloBuffer.prefix(upTo: newline))
            guard let url = URL(string: hello.endpoint), url.scheme == "http", url.host == "127.0.0.1",
                  let port = url.port, port > 0, url.path.isEmpty, url.user == nil, url.password == nil,
                  url.query == nil, url.fragment == nil,
                  hello.token.count == 64, hello.token.allSatisfy({ "0123456789abcdef".contains($0) }) else {
                showFailure("启动器后台握手失败。"); return
            }
            bridge = url; credential = "Bearer " + hello.token; helloBuffer.removeAll(keepingCapacity: false)
            testProgress?.mark("private-handshake-received")
            privateOutput?.fileHandleForReading.readabilityHandler = nil
            poll()
            timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in self?.poll() }
        } catch { showFailure("启动器后台握手失败。") }
    }

    func poll() {
        guard let url = bridge?.appendingPathComponent("state"), let auth = credential, !pollPending, !finishing else { return }
        pollPending = true
        var request = URLRequest(url: url); request.setValue(auth, forHTTPHeaderField: "Authorization")
        session.dataTask(with: request) { [weak self] data, response, error in
            let decoded = data.flatMap { try? JSONDecoder().decode(LauncherState.self, from: $0) }
            DispatchQueue.main.async {
                guard let self = self else { return }; self.pollPending = false
                guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let value = decoded else {
                    self.showFailure("启动器连接已中断。请先保存工作并退出本次 Codex，再重新打开启动器。"); return
                }
                self.connectionFailed = false; self.render(value)
            }
        }.resume()
    }

    func render(_ value: LauncherState) {
        state = value
        status.stringValue = value.status; version.stringValue = value.version
        model.stringValue = value.model; detail.stringValue = value.detail
        dot.layer?.backgroundColor = (value.phase == "running" ? NSColor.systemGreen : value.phase == "error" ? .systemOrange : value.busy ? .systemBlue : .systemGray).cgColor
        primary.title = value.managed ? "重启 Codex" : "启动 Codex"
        primary.isEnabled = !actionPending && !value.busy && value.compatible && (!value.externalRunning || value.managed)
        refresh.isEnabled = !actionPending && !value.busy && !value.managed
        quit.isEnabled = !actionPending && !value.busy
        quit.title = "退出启动器"
        if value.closed {
            if selfTestReport != nil, !testComplete {
                let ok = testStep == 5 && value.selfTestStats?.closes == 3 && value.selfTestStats?.forcedStops == 0
                testComplete = true
                if ok { testChecks.append("quit-waits-for-controller-closed") }
                writeTest(ok, error: ok ? nil : "Controller closed before the complete native-window scenario.")
            }
            beginFinish(); return
        }
        if selfTestReport != nil { advanceTest(value) }
    }

    func sendAction(_ action: String) {
        guard let url = bridge?.appendingPathComponent("action"), let auth = credential,
              ["start", "restart", "refresh", "quit"].contains(action), !actionPending, !finishing else { return }
        actionPending = true; primary.isEnabled = false; refresh.isEnabled = false; quit.isEnabled = false
        var request = URLRequest(url: url); request.httpMethod = "POST"
        request.setValue(auth, forHTTPHeaderField: "Authorization"); request.httpBody = Data(action.utf8)
        session.dataTask(with: request) { [weak self] _, response, error in DispatchQueue.main.async {
            guard let self = self else { return }; self.actionPending = false
            if error != nil || ![202, 409].contains((response as? HTTPURLResponse)?.statusCode ?? 0) {
                self.showFailure("无法发送操作。请刷新状态后重试。"); return
            }
            self.poll()
        } }.resume()
    }

    func confirm(_ restarting: Bool) -> Bool {
        if selfTestReport != nil, let override = confirmationOverride { return override }
        let alert = NSAlert(); alert.alertStyle = .informational
        alert.messageText = restarting ? "重启 Codex？" : "退出启动器？"
        alert.informativeText = restarting ? "这会退出本次启动的 Codex 并重新打开。请等待任务结束并保存工作。" : "退出启动器也会退出本次启动的 Codex。请等待任务结束并保存工作。"
        alert.addButton(withTitle: "取消"); alert.addButton(withTitle: restarting ? "重启" : "退出")
        return alert.runModal() == .alertSecondButtonReturn
    }

    @objc func primaryClicked() {
        guard let value = state, !value.busy, !actionPending else { return }
        if value.managed { if confirm(true) { sendAction("restart") } }
        else { sendAction("start") }
    }
    @objc func refreshClicked() { sendAction("refresh") }
    @objc func quitClicked() { requestQuit() }
    func requestQuit() {
        guard !finishing else { return }
        if connectionFailed { if state?.managed != true || confirm(false) { beginFinish() }; return }
        guard let value = state else { beginFinish(); return }
        guard !value.busy, !actionPending else { return }
        if !value.managed || confirm(false) { sendAction("quit") }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { requestQuit(); return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowTermination { return .terminateNow }
        requestQuit(); return .terminateCancel
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
    func showFailure(_ text: String) {
        connectionFailed = true; status.stringValue = "启动器连接已中断"; detail.stringValue = text
        primary.isEnabled = false; refresh.isEnabled = false; quit.isEnabled = true; quit.title = "关闭窗口"
        dot.layer?.backgroundColor = NSColor.systemOrange.cgColor
        if selfTestReport != nil { failTest(text) }
    }
    func beginFinish() {
        guard !finishing else { return }; finishing = true; timer?.invalidate()
        testProgress?.mark("beginFinish")
        try? parentInput?.fileHandleForWriting.close()
        if backend?.isRunning != true { exitNow() }
        else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                guard let self = self, !self.allowTermination else { return }
                // Keep the window when the controller is still cleaning up.
                self.status.stringValue = "正在等待本次 Codex 退出"
                self.detail.stringValue = "请在 Codex 中保存工作并正常退出。启动器会在后台完成清理后关闭。"
            }
        }
    }
    func exitNow() { testProgress?.mark("exitNow"); allowTermination = true; NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate(); privateOutput?.fileHandleForReading.readabilityHandler = nil
        try? parentInput?.fileHandleForWriting.close()
        session.invalidateAndCancel()
        testProgress?.finish()
    }

    func advanceTest(_ value: LauncherState) {
        guard !value.busy, !actionPending, let stats = value.selfTestStats, !testComplete else { return }
        if stats.forcedStops != 0 { failTest("Unexpected forced process cleanup."); return }
        switch testStep {
        case 0 where stats.inspections == 1:
            testProgress?.mark("test.ready")
            guard primary.isEnabled, refresh.isEnabled, value.model == "gpt-6.1-sol", version.stringValue == "Mock 1.0", window.isVisible else { failTest("Native ready state did not render."); return }
            testChecks.append("ready-state-and-window-visible"); testStep = 1; refresh.performClick(nil)
        case 1 where stats.inspections >= 2:
            testProgress?.mark("test.refresh")
            testChecks.append("refresh-button-read-only"); testStep = 2; primary.performClick(nil)
        case 2 where value.managed && stats.launches == 1:
            testProgress?.mark("test.cancel-and-restart")
            confirmationOverride = false; primary.performClick(nil)
            let cancelledClose = !windowShouldClose(window)
            guard cancelledClose, !actionPending, window.isVisible else { failTest("Cancelled native close sent an action."); return }
            testChecks.append("cancel-restart-and-close-retains-session"); testStep = 3
            confirmationOverride = true; primary.performClick(nil)
        case 3 where value.phase == "error" && stats.closes == 1:
            testProgress?.mark("test.graceful-timeout")
            guard value.managed, window.isVisible, primary.isEnabled, quit.isEnabled, stats.launches == 1 else { failTest("Quit timeout did not retain the native window and session."); return }
            testChecks.append("graceful-timeout-keeps-window-and-session"); testStep = 4; primary.performClick(nil)
        case 4 where value.managed && stats.launches == 2 && stats.closes == 2:
            testProgress?.mark("test.restart-recovered")
            testChecks.append("restart-retry-starts-new-owned-session")
            do {
                try screenshot()
                let original = detail.stringValue
                detail.stringValue = String(repeating: "兼容性检查提示：请先保存任务并正常退出 Codex，再刷新状态。", count: 20)
                window.contentView?.layoutSubtreeIfNeeded()
                let content = window.contentView!
                let detailBounds = detail.convert(detail.bounds, to: content)
                let footerBounds = footer.convert(footer.bounds, to: content)
                let gap = detailBounds.minY - footerBounds.maxY
                testLayout = ["detailHeight": detailBounds.height, "detailBottom": detailBounds.minY,
                              "footerTop": footerBounds.maxY, "gap": gap]
                try screenshot(name: "window-long-detail.png")
                detail.stringValue = original
                window.contentView?.layoutSubtreeIfNeeded()
                guard gap >= 8 else { failTest("Long detail overlaps the native window footer."); return }
                testChecks.append("long-detail-does-not-overlap-footer")
            } catch { failTest("Could not capture the native window."); return }
            testStep = 5; quit.performClick(nil)
        default: break
        }
    }
    func screenshot(name: String = "window.png") throws {
        guard let report = selfTestReport, let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded(); content.displayIfNeeded()
        guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { throw NSError(domain: "NativeWindow", code: 1) }
        content.cacheDisplay(in: content.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "NativeWindow", code: 2) }
        try FileManager.default.createDirectory(at: report.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: report.deletingLastPathComponent().appendingPathComponent(name))
    }
    func writeTest(_ ok: Bool, error: String? = nil) {
        guard let report = selfTestReport else { return }
        var result: [String: Any] = ["ok": ok, "nativeWindow": "AppKit", "mockOnly": true, "checks": testChecks,
            "realCodexStarted": false, "realApiRequests": 0, "configuredModelDisplayed": model.stringValue,
            "layout": testLayout]
        if let error = error { result["error"] = error }
        do {
            try FileManager.default.createDirectory(at: report.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: report)
        } catch { fputs("Could not write native self-test report.\n", stderr) }
    }
    func failTest(_ text: String) {
        guard !testComplete else { return }; testComplete = true; writeTest(false, error: text)
        beginFinish()
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--help"] {
    print("Codex Speed Launcher: native macOS compact window\n--self-test REPORT_PATH  Isolated AppKit and controller test; no real Codex or credentials")
    exit(0)
}
var report: URL? = nil
var root = Bundle.main.resourceURL?.appendingPathComponent("launcher")
var index = 0
while index < arguments.count {
    guard index + 1 < arguments.count else { fputs("Missing native launcher argument.\n", stderr); exit(1) }
    switch arguments[index] {
    case "--self-test": report = URL(fileURLWithPath: arguments[index + 1]).standardizedFileURL
    case "--launcher-root": root = URL(fileURLWithPath: arguments[index + 1], isDirectory: true).standardizedFileURL
    default: fputs("Unknown native launcher argument.\n", stderr); exit(1)
    }
    index += 2
}
guard let resources = root else { fputs("Launcher bundle resources are missing.\n", stderr); exit(1) }
let progress = report.map { SelfTestProgress(report: $0) }
progress?.mark("before-NSApplication.shared")
let application = NSApplication.shared
progress?.mark("after-NSApplication.shared")
application.setActivationPolicy(.regular)
progress?.mark("after-setActivationPolicy")
let delegate = LauncherApp(root: resources, report: report, progress: progress)
application.delegate = delegate
progress?.mark("before-application.run")
withExtendedLifetime(delegate) { application.run() }
progress?.finish()
