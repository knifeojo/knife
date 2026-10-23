import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'models.dart';

class LedgerApi {
  LedgerApi({required this.baseUrl, this.token, http.Client? httpClient}) : _http = httpClient ?? http.Client();

  final String baseUrl;
  final String? token;
  final http.Client _http;

  static const _timeout = Duration(seconds: 30);
  static const _uploadTimeout = Duration(seconds: 90);

  Future<bool> health() async {
    final json = await _object(_uri('/api/v1/health'), _get);
    return json['ok'] == true && json['service'] == 'ledger';
  }

  Future<AuthSession> login({required String email, required String password}) {
    return _session('/api/v1/auth/login', {'email': email, 'password': password});
  }

  Future<AuthSession> signup({required String email, required String password, String? name}) {
    return _session('/api/v1/auth/signup', {
      'email': email,
      'password': password,
      if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
    });
  }

  Future<void> logout() async {
    await _object(_uri('/api/v1/auth/logout'), (uri) => _post(uri, const {}));
  }

  Future<UserProfile> session() {
    return _parse(_object(_uri('/api/v1/auth/session'), _get), (json) => UserProfile.fromJson(_asMap(json['user'])));
  }

  Future<AccountList> accounts() {
    return _parse(_object(_uri('/api/v1/accounts'), _get), AccountList.fromJson);
  }

  /// `cadence` is "recurring" or "one_off"; older servers ignore it.
  Future<TransactionPage> transactions({String? category, String? query, String? cadence, int page = 1}) {
    return _parse(
      _object(_uri('/api/v1/transactions', {'category': category, 'q': query, 'cadence': cadence, 'page': '$page', 'pageSize': '50'}), _get),
      TransactionPage.fromJson,
    );
  }

  Future<HomeSummary> summary({int offset = 0}) {
    return _parse(_object(_uri('/api/v1/summary', {'offset': '$offset'}), _get), HomeSummary.fromJson);
  }

  /// `horizon` is "month_end" or a number of days from 1 to 120.
  Future<AffordabilityCheck> affordability({required String amountMinor, String? description, String horizon = 'month_end', String? bufferMinor}) {
    return _parse(
      _object(
        _uri('/api/v1/affordability'),
        (uri) => _post(uri, {
          'amountMinor': amountMinor,
          if (description != null && description.trim().isNotEmpty) 'description': description.trim(),
          'horizon': horizon,
          'bufferMinor': ?bufferMinor,
        }),
      ),
      AffordabilityCheck.fromJson,
    );
  }

  Future<List<StatementFileResult>> uploadStatement({required String filename, required Uint8List bytes, String? password}) async {
    final request = http.MultipartRequest('POST', _uri('/api/v1/statements'));
    request.headers.addAll(_headers());
    request.files.add(http.MultipartFile.fromBytes('file', bytes, filename: filename));
    if (password != null && password.isNotEmpty) request.fields['password'] = password;
    final streamed = await _http.send(request).timeout(_uploadTimeout);
    final response = await http.Response.fromStream(streamed);
    final json = _read(response);
    final results = json['results'];
    if (results is! List) throw ApiException(response.statusCode, 'The server did not return an import result.');
    try {
      return results.map((item) => StatementFileResult.fromJson(_asMap(item))).toList();
    } on FormatException catch (error) {
      throw ApiException(response.statusCode, error.message);
    }
  }

  Future<T> _parse<T>(Future<Map<String, dynamic>> json, T Function(Map<String, dynamic> json) parse) async {
    try {
      return parse(await json);
    } on FormatException catch (error) {
      throw ApiException(0, error.message);
    }
  }

  Future<AuthSession> _session(String path, Map<String, String> body) async {
    final json = await _object(_uri(path), (uri) => _post(uri, body));
    return AuthSession.fromJson(json);
  }

  Map<String, String> _headers({bool json = false}) {
    return {
      'Accept': 'application/json',
      if (json) 'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };
  }

  Future<http.Response> _get(Uri uri) => _http.get(uri, headers: _headers()).timeout(_timeout);

  Future<http.Response> _post(Uri uri, Map<String, String> body) {
    return _http.post(uri, headers: _headers(json: true), body: jsonEncode(body)).timeout(_timeout);
  }

  Future<Map<String, dynamic>> _object(Uri uri, Future<http.Response> Function(Uri uri) send) async {
    try {
      return _read(await send(uri));
    } on ApiException {
      rethrow;
    } on FormatException catch (error) {
      throw ApiException(0, error.message);
    } on TimeoutException {
      throw const ApiException(0, 'The server did not respond. Check the URL and that Ledger is running.');
    } on http.ClientException {
      throw const ApiException(0, 'Could not reach that server. Check the URL and that Ledger is running.');
    } catch (_) {
      throw const ApiException(0, 'Could not read the server response.');
    }
  }

  Map<String, dynamic> _read(http.Response response) {
    if (response.body.isEmpty) {
      if (response.statusCode >= 400) throw ApiException(response.statusCode, 'Request failed (${response.statusCode}).');
      return {};
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } catch (_) {
      throw ApiException(response.statusCode, 'The server returned something that was not JSON.');
    }
    if (response.statusCode >= 400) {
      final message = decoded is Map && decoded['error'] is String ? decoded['error'] as String : 'Request failed (${response.statusCode}).';
      throw ApiException(response.statusCode, message);
    }
    return _asMap(decoded);
  }

  Uri _uri(String path, [Map<String, String?>? query]) {
    final params = <String, String>{};
    query?.forEach((key, value) {
      if (value != null && value.isNotEmpty) params[key] = value;
    });
    return Uri.parse(baseUrl).replace(path: path, queryParameters: params.isEmpty ? null : params);
  }
}

Map<String, dynamic> _asMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return value.map((key, item) => MapEntry(key.toString(), item));
  throw const FormatException('The server returned something that was not JSON.');
}
