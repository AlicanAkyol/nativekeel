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

// Google Play 16 KB memory page size requirement for apps targeting Android 15+.
// https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html
// React Native supports 16 KB pages from 0.77.
export const PAGE_SIZE_16K = { since: '2025-11-01', extensionUntil: '2026-05-31', firstRnMinor: 77 };

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
};

export const UPGRADE_HELPER_URL = (from, to) =>
  `https://react-native-community.github.io/upgrade-helper/?from=${from}&to=${to}`;
