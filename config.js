// Settings for the web app. See README-WEB.md, "OneDrive".
export const CONFIG = {
  // Application (client) ID of the app registered in Microsoft Entra (portal.azure.com -> App registrations).
  // Leave empty to hide the OneDrive features.
  onedriveClientId: '',
  // "common" = personal Microsoft accounts and work / school accounts.
  authority: 'https://login.microsoftonline.com/common',
};
