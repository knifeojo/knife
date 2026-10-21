import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ledger_mobile/api/client.dart';
import 'package:ledger_mobile/api/models.dart';

void main() {
  test('sends the bearer token and keeps minor units as strings', () async {
    late http.Request seen;
    final api = LedgerApi(
      baseUrl: 'http://100.64.0.8:3000',
      token: 'session-token-value',
      httpClient: MockClient((request) async {
        seen = request;
        return http.Response(
          jsonEncode({
            'accounts': [
              {
                'id': 'a1',
                'institution': 'GTBank',
                'accountName': 'GTBank NGN ••4521',
                'maskedAccountNumber': '****4521',
                'holderName': 'Ada Okafor',
                'currency': 'NGN',
                'balanceMinor': '450000000',
                'balanceUpdatedAt': '2026-09-25T00:00:00.000Z',
              },
            ],
            'totalBaseMinor': '450000000',
            'totalBaseCurrency': 'NGN',
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );

    final accounts = await api.accounts();
    expect(seen.url.toString(), 'http://100.64.0.8:3000/api/v1/accounts');
    expect(seen.headers['authorization'], 'Bearer session-token-value');
    expect(accounts.accounts.single.balanceMinor, '450000000');
    expect(accounts.totalBaseMinor, '450000000');
  });

  test('turns an error body into a message and uploads a statement with its password field', () async {
    final api = LedgerApi(
      baseUrl: 'https://ledger.example',
      token: 'tok-tok-tok-tok-tok',
      httpClient: MockClient((request) async {
        if (request.url.path.endsWith('/auth/login')) {
          return http.Response(
            jsonEncode({'error': 'Invalid email or password'}),
            401,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }
        expect(request.headers['authorization'], 'Bearer tok-tok-tok-tok-tok');
        expect(request.body, contains('filename="statement.csv"'));
        expect(request.body, contains('name="password"'));
        expect(request.body, contains('pdf-secret'));
        expect(request.body, contains('date,amount'));
        return http.Response(
          jsonEncode({
            'results': [
              {
                'file': 'statement.csv',
                'ok': {
                  'institution': 'GTBank',
                  'currency': 'NGN',
                  'rowsRead': 1,
                  'created': 1,
                  'duplicates': 0,
                  'accountLast4': '4521',
                  'balanceBreaks': 0,
                  'gap': null,
                  'complete': true,
                },
              },
            ],
          }),
          200,
        );
      }),
    );

    expect(
      () => api.login(email: 'ada@ledger.test', password: 'wrong-password'),
      throwsA(isA<ApiException>().having((error) => error.message, 'message', 'Invalid email or password').having((error) => error.status, 'status', 401)),
    );

    final results = await api.uploadStatement(filename: 'statement.csv', bytes: Uint8List.fromList(utf8.encode('date,amount\n')), password: 'pdf-secret');
    expect(results.single.describe(), contains('1 new'));
    expect(results.single.describe(), isNot(contains('pdf-secret')));
  });

  test('health accepts only a ledger server', () async {
    final api = LedgerApi(
      baseUrl: 'http://127.0.0.1:3000',
      httpClient: MockClient((request) async => http.Response(jsonEncode({'ok': true, 'service': 'other', 'version': 1}), 200)),
    );
    expect(await api.health(), isFalse);
  });
}
