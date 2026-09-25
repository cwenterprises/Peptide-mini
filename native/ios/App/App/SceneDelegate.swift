import UIKit
import Capacitor

/// UIScene lifecycle — required for apps built with the iOS 27 SDK: without it
/// UIKit traps at launch (_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
/// The window and AppViewController still come from Main.storyboard (UISceneStoryboardFile).
///
/// With scenes, UIKit delivers URL opens and Universal Links (vial-label QR scans) to the
/// scene instead of the AppDelegate, so forward them to Capacitor's ApplicationDelegateProxy
/// exactly as AppDelegate did — that is what fires the App plugin's appUrlOpen event.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // Cold launch from a link: the URL / activity arrives here, not in the methods below.
        if let userActivity = connectionOptions.userActivities.first {
            self.scene(scene, continue: userActivity)
        }
        if !connectionOptions.urlContexts.isEmpty {
            self.scene(scene, openURLContexts: connectionOptions.urlContexts)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: [:])
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
