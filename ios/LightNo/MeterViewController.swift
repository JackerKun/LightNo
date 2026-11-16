import AVFoundation
import UIKit
import WebKit

final class MeterViewController: UIViewController, WKNavigationDelegate, WKDownloadDelegate {
    private lazy var camera = CameraSession { [weak self] event in
        DispatchQueue.main.async { self?.publish(event) }
    }
    private var webView: WKWebView!
    private var stream: Int?
    private var previewFPS = 10
    private let assets = WebAssets()
    private var exports: [WKDownload: URL] = [:]
    private var observers: [NSObjectProtocol] = []
    private lazy var loadErrorView: UIStackView = {
        let message = UILabel()
        message.text = "测光界面加载失败"
        message.textColor = .label
        message.font = .preferredFont(forTextStyle: .headline)
        message.adjustsFontForContentSizeCategory = true
        message.textAlignment = .center
        message.numberOfLines = 0

        var buttonStyle = UIButton.Configuration.filled()
        buttonStyle.title = "重新加载"
        let retry = UIButton(configuration: buttonStyle, primaryAction: UIAction { [weak self] _ in
            self?.loadPage()
        })
        let panel = UIStackView(arrangedSubviews: [message, retry])
        panel.axis = .vertical
        panel.alignment = .center
        panel.spacing = 16
        panel.backgroundColor = view.backgroundColor
        panel.isHidden = true
        panel.translatesAutoresizingMaskIntoConstraints = false
        return panel
    }()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.02, green: 0.025, blue: 0.04, alpha: 1)
        overrideUserInterfaceStyle = .dark
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(assets, forURLScheme: WebAssets.scheme)
        config.userContentController.add(CameraMessages(self), name: "lightno")
        config.userContentController.addUserScript(WKUserScript(source: """
            window.LightNoHost = Object.freeze({
              version: 1,
              send(message) { window.webkit.messageHandlers.lightno.postMessage(message); }
            });
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        view.addSubview(loadErrorView)
        NSLayoutConstraint.activate([
            loadErrorView.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
            loadErrorView.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            loadErrorView.widthAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.widthAnchor, constant: -32)
        ])
        loadPage()

        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in
            guard let self, let stream = self.stream else { return }
            self.publish(["type": "paused", "session": stream])
            self.camera.stop(stream)
            self.assets.clearPreview()
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
            guard let self, let stream = self.stream else { return }
            self.startCamera(stream)
        })
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        if action.shouldPerformDownload, url.scheme == "blob", action.sourceFrame.isMainFrame,
           let origin = action.sourceFrame.request.url, WebAssets.matches(origin) {
            decisionHandler(.download)
        } else if WebAssets.matches(url) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated, url.scheme == "https" {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let name = (suggestedFilename as NSString).lastPathComponent
        guard !name.isEmpty, ![".", "..", "/"].contains(name) else {
            completionHandler(nil)
            return
        }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            let file = directory.appendingPathComponent(name, isDirectory: false)
            exports[download] = file
            completionHandler(file)
        } catch {
            completionHandler(nil)
            showExportError()
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = exports.removeValue(forKey: download) else { return }
        let directory = file.deletingLastPathComponent()
        guard presentedViewController == nil else {
            try? FileManager.default.removeItem(at: directory)
            return
        }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: directory)
        }
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = exports.removeValue(forKey: download) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        if (error as NSError).code != NSURLErrorCancelled { showExportError() }
    }

    private func showExportError() {
        let alert = UIAlertController(title: "导出失败", message: "请稍后重试。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }

    private func loadPage() {
        loadErrorView.isHidden = true
        webView.isHidden = false
        webView.load(URLRequest(url: WebAssets.startURL))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        showLoadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    private func showLoadError(_ error: Error) {
        let failure = error as NSError
        if failure.domain == NSURLErrorDomain, failure.code == NSURLErrorCancelled { return }
        NSLog("LightNo could not load its bundled interface: %@", failure.localizedDescription)
        webView.isHidden = true
        loadErrorView.isHidden = false
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let stream { camera.stop(stream) }
        stream = nil
        assets.clearPreview()
        UIApplication.shared.isIdleTimerDisabled = false
        loadPage()
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let origin = message.frameInfo.request.url, WebAssets.matches(origin),
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        if type == "keepAwake", let enabled = body["enabled"] as? Bool {
            UIApplication.shared.isIdleTimerDisabled = enabled
            return
        }

        guard let id = body["session"] as? Int, id > 0 else { return }
        if type == "start" {
            if let stream, stream != id { camera.stop(stream) }
            stream = id
            let fps = body["fps"] as? Int ?? 10
            previewFPS = min(20, max(4, fps))
            startCamera(id)
            return
        }
        guard stream == id else { return }
        switch type {
        case "stop":
            camera.stop(id)
            stream = nil
            assets.clearPreview()
        case "previewRate":
            guard let fps = body["fps"] as? Int, (4...20).contains(fps) else { return }
            previewFPS = fps
            camera.setPreviewRate(stream: id, fps: fps)
        case "nextFrame":
            camera.nextFrame(id)
        case "meterPoint":
            guard let x = body["x"] as? Double, let y = body["y"] as? Double,
                  (0...1).contains(x), (0...1).contains(y),
                  let revision = body["revision"] as? Int, revision >= 0 else { return }
            camera.setMeterPoint(stream: id, x: x, y: y, revision: revision)
        default:
            break
        }
    }

    private func startCamera(_ id: Int) {
        guard UIApplication.shared.applicationState != .background, stream == id else { return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            camera.start(id, fps: previewFPS)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, self.stream == id else { return }
                    if granted { self.startCamera(id) }
                    else { self.permissionDenied(id) }
                }
            }
        default:
            permissionDenied(id)
        }
    }

    private func permissionDenied(_ id: Int) {
        publish([
            "type": "error", "session": id, "code": "DENIED", "message": "需要相机权限",
            "hint": "请在 iPhone 的「设置 → LightNo」中允许相机，然后点重试。"
        ])
    }

    private func publish(_ event: CameraSession.Event) {
        guard let stream, event["session"] as? Int == stream else { return }
        var payload = event
        if let jpeg = payload.removeValue(forKey: "jpegData") as? Data {
            guard UIApplication.shared.applicationState != .background else { return }
            payload["frameURL"] = assets.storePreview(jpeg)
        }
        webView.callAsyncJavaScript("""
            window.dispatchEvent(new CustomEvent('lightno-native-camera', { detail: event }));
            """, arguments: ["event": payload], in: nil, in: .page, completionHandler: nil)
    }
}

private final class CameraMessages: NSObject, WKScriptMessageHandler {
    private weak var owner: MeterViewController?

    init(_ owner: MeterViewController) { self.owner = owner }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}

private final class WebAssets: NSObject, WKURLSchemeHandler {
    static let scheme = "lightno"
    static let startURL = URL(string: "\(scheme)://app/index.html")!
    private var previewSequence: UInt64 = 0
    private var preview: (path: String, jpeg: Data)?

    // Only the latest requested frame is retained, and it never touches disk.
    func storePreview(_ jpeg: Data) -> String {
        previewSequence += 1
        let path = "/__preview/\(previewSequence).jpg"
        preview = (path, jpeg)
        return "\(Self.scheme)://app\(path)"
    }

    func clearPreview() {
        preview = nil
    }
    private let contentTypes = [
        "html": "text/html", "js": "text/javascript", "css": "text/css",
        "png": "image/png", "svg": "image/svg+xml", "webmanifest": "application/manifest+json"
    ]

    static func matches(_ url: URL) -> Bool { url.scheme == scheme && url.host == "app" }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, Self.matches(url) else {
            task.didFailWithError(URLError(.resourceUnavailable))
            return
        }
        if url.path.hasPrefix("/__preview/") {
            guard let preview, preview.path == url.path,
                  let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "image/jpeg", "Cache-Control": "no-store"]) else {
                task.didFailWithError(URLError(.resourceUnavailable))
                return
            }
            task.didReceive(response)
            task.didReceive(preview.jpeg)
            task.didFinish()
            return
        }
        guard let resources = Bundle.main.resourceURL,
              let type = contentTypes[url.pathExtension] else {
            task.didFailWithError(URLError(.resourceUnavailable))
            return
        }
        let components = url.path.split(separator: "/")
        guard !components.isEmpty, components.allSatisfy({ $0 != "." && $0 != ".." }) else {
            task.didFailWithError(URLError(.resourceUnavailable))
            return
        }
        let root = resources.appendingPathComponent("Web", isDirectory: true)
        let file = root.appendingPathComponent(components.joined(separator: "/"), isDirectory: false)
        guard let data = try? Data(contentsOf: file),
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": type, "Access-Control-Allow-Origin": "*"]) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
