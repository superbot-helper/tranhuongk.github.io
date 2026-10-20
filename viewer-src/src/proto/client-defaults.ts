// Fixed and browser-specific field values for the registration / lookup / login messages.
// Sources (MacViewer, read-only $MV):
//   Sources/MacViewer/MacRegistrationProfile.swift:96-134 (loadOrCreate) and :201-211
//     (newPassword, deviceIdentity, operatingSystemWireValue, displayName), :241-252 (makeRequest)
//   Sources/UltraViewerProtocol/UltraViewerRelaySession.swift:323-364 (PeerLookup.Request values)
//     and :606-636 (PartnerLoginMessage.Context values)
// Everything marked "browser" has no Swift equivalent and is a choice for the web viewer.
import type { RegistrationRequest } from './registration';

/** MacRegistrationProfile.makeRequest: clientVersion "6.6.133" (also used in lookup and login). */
export const CLIENT_VERSION = '6.6.133';

/** UltraViewerRelaySession.login: screenTwipsPerPixelX/YText "15". */
export const TWIPS_PER_PIXEL_TEXT = '15';

/**
 * Browser: Swift sends the Mac hostname base64-encoded (`Data(hostName.utf8).base64EncodedString()`).
 * The browser has no hostname; "WebViewer" (analogue of MacViewer's defaultDisplayName).
 */
export const COMPUTER_NAME_UTF8_BASE64 = 'V2ViVmlld2Vy'; // base64("WebViewer")

/**
 * Browser: Swift sends `userNameWireValue(NSUserName())`, i.e. the name verbatim when ASCII.
 */
export const USER_NAME_WIRE_VALUE = 'webviewer';

/**
 * Browser: Swift's operatingSystemWireValue is "patch|major|0|minor|0|0" from the real Mac
 * version. A browser cannot read the OS version reliably, so a fixed value in the same format
 * (macOS 15.0.0) is sent.
 */
export const OPERATING_SYSTEM_WIRE_VALUE = '0|15|0|0|0|0';

/** Browser: login display name, analogue of MacRegistrationProfile.defaultDisplayName ("MacViewer"). */
export const DEFAULT_DISPLAY_NAME = 'WebViewer';

/** Identity fields that vary per device; see session/identity.ts `ClientIdentity`. */
export interface RegistrationIdentity {
  deviceIdentity: string;
  password: string;
  localAddress: string;
  macAddress: string;
}

/** MacRegistrationProfile.makeRequest with the browser values above. */
export function makeRegistrationRequest(identity: RegistrationIdentity): RegistrationRequest {
  return {
    deviceIdentity: identity.deviceIdentity,
    password: identity.password,
    localAddress: identity.localAddress,
    computerNameUTF8Base64: COMPUTER_NAME_UTF8_BASE64,
    clientVersion: CLIENT_VERSION,
    macAddress: identity.macAddress,
    diskIdentity: '',
    operatingSystem: OPERATING_SYSTEM_WIRE_VALUE,
    installerReferral: 0,
    customPassword: '',
    usesProxy: false,
    quickSupportMetadata: '',
    userNameWireValue: USER_NAME_WIRE_VALUE,
    activeSessionID: 0,
    processSessionID: 0,
    preferredIDText: '0',
    referralIDText: '0',
    automaticUpdate: 0,
    systemFolderCreationTicks: '0',
    programFilesCreationTicks: '0',
    systemVolumeInformationCreationTicks: '0',
    licenseContext1: '',
    licenseContext2: '',
    captchaToken: '',
  };
}

/**
 * UltraViewerRelaySession.consumeCommand: PeerLookup.Request fields that are constants.
 * Caller supplies targetID, credential, clientVersion, licenseContext*, localID, localPassword,
 * correlationNumber and dateTimeOffsetMinutes (Swift: secondsFromGMT / 60).
 * `licenseContext` / `additionalLicenseContext` come from the registration request (both "").
 */
export const LOOKUP_DEFAULTS = {
  licenseContext: '',
  additionalLicenseContext: '',
  targetSessionID: -1,
  isReconnect: false,
  referralIDText: '0',
  paymentTypeText: '0',
  objectDictionaryCount: 1,
  fixedPingList: '',
} as const;

/**
 * UltraViewerRelaySession.login: PartnerLoginMessage.Context fields that are constants.
 * Caller supplies screenPixelWidth/Height (Task 7: round(screen.width * devicePixelRatio)),
 * localID, displayName, controlMode, clearControlMode, connectionHashKey, partnerSecretToken
 * and clientVersion.
 */
export const LOGIN_DEFAULTS = {
  desktopMetric: 0,
  screenTwipsPerPixelXText: TWIPS_PER_PIXEL_TEXT,
  screenTwipsPerPixelYText: TWIPS_PER_PIXEL_TEXT,
  formVerticalInset: 0,
  formHorizontalInset: 0,
  displayName: DEFAULT_DISPLAY_NAME,
  localUserSID: '',
  displayColors: 2,
  displayQuality: 45,
  remoteWallpaperDisabled: 0,
  hasDesktopToken: false,
  clientVersion: CLIENT_VERSION,
  desktopCounter: 0,
} as const;
