/// Returns an error message, or null when [raw] is an origin the app can store.
String? validateServerUrl(String raw) {
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return 'Enter the server URL.';
  final uri = Uri.tryParse(trimmed);
  if (uri == null || !_isHttp(uri) || uri.host.isEmpty) {
    return 'Use a full URL, like http://100.64.0.1:3000';
  }
  if (uri.userInfo.isNotEmpty) return 'Remove any username or password from the URL.';
  if (uri.path.isNotEmpty && uri.path != '/') return 'Use the server origin only, without a path.';
  if (uri.query.isNotEmpty || uri.fragment.isNotEmpty) return 'Use the server origin only, without a query.';
  return null;
}

String normalizeServerUrl(String raw) {
  var value = raw.trim();
  while (value.endsWith('/')) {
    value = value.substring(0, value.length - 1);
  }
  return value;
}

/// HTTP to a public network is readable. Tailscale still encrypts 100.64.0.0/10,
/// but the app cannot prove the address is on the tailnet, so it warns for any http URL.
bool warnsAboutCleartext(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null || uri.scheme != 'http') return false;
  final host = uri.host.toLowerCase();
  return host != 'localhost' && host != '127.0.0.1';
}

bool _isHttp(Uri uri) => uri.scheme == 'http' || uri.scheme == 'https';
