import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/server_url.dart';

void main() {
  test('accepts an origin and strips a trailing slash', () {
    expect(validateServerUrl('http://100.64.0.8:3000'), isNull);
    expect(normalizeServerUrl('http://100.64.0.8:3000/'), 'http://100.64.0.8:3000');
    expect(validateServerUrl('https://laptop.tailnet.ts.net'), isNull);
  });

  test('rejects a bare host, a path, and embedded credentials', () {
    expect(validateServerUrl('100.64.0.8:3000'), isNotNull);
    expect(validateServerUrl('http://100.64.0.8:3000/ledger'), isNotNull);
    expect(validateServerUrl('http://user:secret@100.64.0.8:3000'), isNotNull);
    expect(validateServerUrl(''), isNotNull);
  });

  test('warns on http except localhost', () {
    expect(warnsAboutCleartext('http://100.64.0.8:3000'), isTrue);
    expect(warnsAboutCleartext('http://127.0.0.1:3000'), isFalse);
    expect(warnsAboutCleartext('https://ledger.example'), isFalse);
  });
}
