// Curated knowledge that the public registries do not provide.
// Every entry here is a claim we make to users, so keep it short, sourced and dated.

// The React Native team supports the latest minor and the two before it.
// https://github.com/reactwg/react-native-releases/blob/main/docs/support.md
export const SUPPORTED_RN_MINORS = 3;

// Out of support is a risk, not an outage. It becomes critical once the gap is about a year
// of releases (roughly six minors), when upgrades turn into projects.
export const CRITICAL_RN_MINORS_BEHIND = 6;

// First React Native minor where the legacy architecture is removed.
export const NEW_ARCH_ONLY_MINOR = 82;

// Expo ships about three SDKs a year and fixes only recent ones.
export const SUPPORTED_EXPO_MAJORS = 3;
export const CRITICAL_EXPO_MAJORS_BEHIND = 5;

// Google Play target API level policy.
// https://support.google.com/googleplay/android-developer/answer/11926878
export const PLAY_TARGET_SDK = {
  checkedAt: '2026-10-03',
  // New apps and app updates
  updates: { minimum: 36, since: '2026-08-31', extensionUntil: '2026-11-01' },
  // Already published apps stay visible to users on newer Android versions only above this
  visibility: { minimum: 35, since: '2026-08-31' },
};

// Google Play 16 KB memory page size requirement for apps targeting Android 15+: policy since
// 2025-11-01; Play blocks updates without it from 2027-02-01 (checked 2026-10-06 on
// https://developer.android.com/guide/practices/page-sizes, page updated 2026-09-16).
// React Native supports 16 KB pages from 0.77.
export const PAGE_SIZE_16K = { since: '2025-11-01', blockedFrom: '2027-02-01', firstRnMinor: 77 };

// Minimum OS versions of current React Native (since 0.76).
// https://reactnative.dev/blog/2024/10/23/release-0.76-new-architecture
export const PLATFORM_MINIMUMS = { androidMinSdk: 24, iosMin: 15.1 };

// A package with no npm release for this long will not follow React Native, iOS or Android changes.
export const STALE_RELEASE_DAYS = 730;
// A release this recent overrides an "unmaintained" flag that may be out of date.
export const RECENT_RELEASE_DAYS = 180;

// Replacement advice for native modules we have seen block upgrades.
// Only used when React Native Directory has no alternatives listed.
export const REPLACEMENTS = {
  'react-native-fast-image': ['expo-image', '@d11/react-native-fast-image'],
  'react-native-fs': ['@dr.pogodin/react-native-fs', 'expo-file-system'],
  '@react-native-community/push-notification-ios': ['@react-native-firebase/messaging', 'expo-notifications'],
  'react-native-keyboard-aware-scroll-view': ['react-native-keyboard-controller'],
  'react-native-splash-screen': ['react-native-bootsplash', 'expo-splash-screen'],
  'react-native-camera': ['react-native-vision-camera', 'expo-camera'],
  'react-native-sqlite-storage': ['op-sqlite', 'expo-sqlite'],
  'react-native-code-push': ['expo-updates'],
  // react-native-elements was renamed to @rneui, which in turn is continued by @rn-vui.
  'react-native-elements': ['@rn-vui/themed'],
  // Checked on npm and React Native Directory on 2026-10-04 (published and not flagged unmaintained).
  'rn-fetch-blob': ['react-native-blob-util'],
  '@react-native-community/blur': ['expo-blur'],
  'react-native-randombytes': ['react-native-get-random-values', 'expo-crypto'],
  'react-native-securerandom': ['react-native-get-random-values', 'expo-crypto'],
  'react-native-tcp': ['react-native-tcp-socket'],
  '@react-native-community/geolocation': ['expo-location'],
  'react-native-geolocation-service': ['expo-location'],
  'react-native-encrypted-storage': ['react-native-keychain', 'expo-secure-store'],
  'react-native-navigation-bar-color': ['react-native-edge-to-edge', 'expo-navigation-bar'],
  'react-native-quick-actions': ['expo-quick-actions'],
  'react-native-version-number': ['react-native-device-info', 'expo-application'],
  'react-native-mail': ['expo-mail-composer'],
  'react-native-rate': ['expo-store-review'],
  'react-native-print': ['expo-print'],
  'react-native-i18n': ['react-native-localize', 'expo-localization'],
  'expo-av': ['expo-audio', 'expo-video'],
  'react-native-snap-carousel': ['react-native-reanimated-carousel'],
  'react-native-iphone-x-helper': ['react-native-safe-area-context'],
  'react-native-slider': ['@react-native-community/slider'],
  'react-native-datepicker': ['@react-native-community/datetimepicker'],
};

// What a user needs to know before acting on a dep-risk finding, when the registries cannot
// say it. Shown after the finding's detail. Sourced and dated.
export const PACKAGE_NOTES = {
  // README and rntp.dev/pricing, checked 2026-10-09. v4 branch MusicModule.kt: 37 @ReactMethod
  // functions are written `= scope.launch { }` and return a coroutine Job, which the interop
  // layer rejects ("Detected unsupported return class: kotlinx.coroutines.Job"). expo-audio:
  // lock screen controls and background playback via setActiveForLockScreen, but no
  // next/previous track commands yet (expo/expo#43538). Kotlin 2.1, crash and the first-setupPlayer
  // race reproduced on RN 0.81.4 and fixed in our PR #2685 (tested on an emulator, 2026-10-09).
  'react-native-track-player':
    'Version 5, the New Architecture rewrite, is a different package (@rntp/player) under a commercial license: free for personal and educational use, paid for commercial apps (rntp.dev/pricing). The free 4.x line (4.1.2) does not compile with Kotlin 2.1 (React Native 0.79+) and crashes at launch on Android with the New Architecture (its methods return a coroutine Job); the fixes are in github.com/doublesymmetry/react-native-track-player/pull/2685, which you can apply with patch-package until it is released. For simple playback, expo-audio has background playback and lock screen controls, but no next/previous track commands yet.',
  // RNPushNotificationListenerService.onNewToken and RNPushNotificationActions (8.1.1) call
  // getReactNativeHost() on the main thread without a guard. ReactApplication.reactNativeHost
  // throws by default from React Native 0.82 (ReactApplication.kt), and the 0.82+ template's
  // MainApplication no longer overrides it. Checked 2026-10-09.
  'react-native-push-notification':
    'It calls getReactNativeHost() when the FCM token refreshes (on every fresh install) and when a notification action is tapped. From React Native 0.82 that getter throws unless MainApplication still overrides reactNativeHost, which the 0.82+ template no longer does, so the app crashes there. Replace it before that upgrade, or keep reactNativeHost in MainApplication.',
};

// Packages that moved to a new name with the same API: swap the package, update the imports.
export const RENAMED = {
  '@react-native-community/async-storage': '@react-native-async-storage/async-storage',
  '@react-native-community/cameraroll': '@react-native-camera-roll/camera-roll',
  '@react-native-community/masked-view': '@react-native-masked-view/masked-view',
  '@react-native-community/viewpager': 'react-native-pager-view',
  '@react-native-community/picker': '@react-native-picker/picker',
  '@react-native-community/clipboard': '@react-native-clipboard/clipboard',
  'react-native-netinfo': '@react-native-community/netinfo',
};

export const UPGRADE_HELPER_URL = (from, to) =>
  `https://react-native-community.github.io/upgrade-helper/?from=${from}&to=${to}`;
