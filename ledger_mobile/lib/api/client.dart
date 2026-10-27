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

  /// `cadence` is "recurring", "one_off" or "everyday"; `payee` matches every spelling of one name.
  /// `from` and `to` are inclusive Lagos days (YYYY-MM-DD).
  Future<TransactionPage> transactions({
    String? category,
    String? query,
    String? cadence,
    String? payee,
    String? type,
    String? from,
    String? to,
    int page = 1,
  }) {
    final params = {'category': category, 'q': query, 'cadence': cadence, 'payee': payee, 'type': type, 'from': from, 'to': to};
    return _parse(
      _object(_uri('/api/v1/transactions', {...params, 'page': '$page', 'pageSize': '50'}), _get),
      TransactionPage.fromJson,
    );
  }

  Future<ReviewQueue> review() {
    return _parse(_object(_uri('/api/v1/review'), _get), ReviewQueue.fromJson);
  }

  /// First-run form and the after-upload picker. Older servers answer 404.
  Future<OnboardingState> onboarding() {
    return _onboarding(_parse(_object(_uri('/api/v1/onboarding'), _get), OnboardingState.fromJson));
  }

  Future<OnboardingState> saveOnboarding({
    bool skip = false,
    String? ownName,
    String? relationshipStatus,
    String? partner,
    String? parents,
    String? siblings,
    String? supported,
  }) {
    return _onboarding(
      _parse(
        _object(
          _uri('/api/v1/onboarding'),
          (uri) => _post(uri, {
            if (skip) 'skip': true,
            'ownName': ?ownName,
            'relationshipStatus': ?relationshipStatus,
            'partner': ?partner,
            'parents': ?parents,
            'siblings': ?siblings,
            'supported': ?supported,
          }),
        ),
        OnboardingState.fromJson,
      ),
    );
  }

  Future<OnboardingState> finishTopPeople() {
    return _onboarding(_parse(_object(_uri('/api/v1/onboarding'), (uri) => _post(uri, const {'topPeopleDone': true})), OnboardingState.fromJson));
  }

  Future<T> _onboarding<T>(Future<T> call) async {
    try {
      return await call;
    } on ApiException catch (error) {
      if (error.status == 404) throw const ApiException(404, 'This Ledger server does not have onboarding yet.');
      rethrow;
    }
  }

  /// Answers one Review question. `value` "other" needs `otherText`; "unknown" is "Can't remember" / Skip;
  /// `rel:<relationship>` saves the person ("rel:vendor" takes `vendorCategory`). Returns rows updated.
  Future<int> answerReview({
    required String kind,
    required String key,
    required String value,
    String? otherText,
    String? otherCategory,
    String? vendorCategory,
    String? vendorSubcategory,
  }) async {
    final body = {
      'kind': kind,
      'key': key,
      'value': value,
      'otherText': ?otherText,
      'otherCategory': ?otherCategory,
      'vendorCategory': ?vendorCategory,
      'vendorSubcategory': ?vendorSubcategory,
    };
    final json = await _object(_uri('/api/v1/review'), (uri) => _post(uri, body));
    final updated = json['updated'];
    if (updated is! int) throw const ApiException(0, 'The server did not confirm the answer.');
    return updated;
  }

  /// Confirms (`action` "confirm") or dismisses ("dismiss") an AI suggestion from Review. Returns rows updated.
  Future<int> answerSuggestion({required String id, required String action}) async {
    final json = await _object(_uri('/api/v1/review/suggestions'), (uri) => _post(uri, {'id': id, 'action': action}));
    final updated = json['updated'];
    if (updated is! int) throw const ApiException(0, 'The server did not confirm the answer.');
    return updated;
  }

  Future<AiStatus> aiStatus() => _ai(_parse(_object(_uri('/api/v1/ai'), _get), AiStatus.fromJson));

  /// The Settings toggle. Returns the new status.
  Future<AiStatus> setAiEnabled(bool enabled) {
    return _ai(_parse(_object(_uri('/api/v1/ai'), (uri) => _post(uri, {'enabled': enabled})), AiStatus.fromJson));
  }

  /// Per-feature overrides from Settings: feature to "local", "cloud", "off" or "default" (back to the server's choice).
  Future<AiStatus> setAiRoutes(Map<String, String> routes) {
    return _ai(_parse(_object(_uri('/api/v1/ai'), (uri) => _post(uri, {'routes': routes})), AiStatus.fromJson));
  }

  /// A server from before AI categorization answers 404 with an HTML page.
  Future<T> _ai<T>(Future<T> call) async {
    try {
      return await call;
    } on ApiException catch (error) {
      if (error.status == 404) throw const ApiException(404, 'This Ledger server does not have AI categorization yet.');
      rethrow;
    }
  }

  /// "Re-run categorization", the same server logic as the web Settings button.
  Future<CategorizeResult> rerunCategorization() {
    return _parse(_object(_uri('/api/v1/categorize'), (uri) => _post(uri, const {})), CategorizeResult.fromJson);
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

  Future<PeopleList> people() => _people(_parse(_object(_uri('/api/v1/people'), _get), PeopleList.fromJson));

  /// "My wife is Gift Adebayo Ojo", one per line. Lines it could not read come back in `unread`.
  Future<PeopleList> addPeopleText(String text) {
    return _people(_parse(_object(_uri('/api/v1/people'), (uri) => _post(uri, {'text': text})), PeopleList.fromJson));
  }

  Future<PeopleList> addPerson({required String displayName, required String relationship, String? note, String? vendorCategory, String? vendorSubcategory}) {
    final body = {'displayName': displayName, 'relationship': relationship, 'note': ?note, 'vendorCategory': ?vendorCategory, 'vendorSubcategory': ?vendorSubcategory};
    return _people(_parse(_object(_uri('/api/v1/people'), (uri) => _post(uri, body)), PeopleList.fromJson));
  }

  /// Changes a person and relabels their payments. Only the fields given are sent.
  Future<PeopleList> updatePerson(
    String id, {
    String? relationship,
    String? note,
    String? vendorCategory,
    String? vendorSubcategory,
    List<String>? addAliases,
    List<String>? rejectAliases,
    List<String>? removeAliases,
  }) {
    final body = {
      'relationship': ?relationship,
      'note': ?note,
      'vendorCategory': ?vendorCategory,
      'vendorSubcategory': ?vendorSubcategory,
      'addAliases': ?addAliases,
      'rejectAliases': ?rejectAliases,
      'removeAliases': ?removeAliases,
    };
    return _people(_parse(_object(_personUri(id), (uri) => _patch(uri, body)), PeopleList.fromJson));
  }

  Future<PeopleList> mergePeople({required String targetId, required String sourceId}) {
    return _people(_parse(_object(_uri('/api/v1/people/merge'), (uri) => _post(uri, {'targetId': targetId, 'sourceId': sourceId})), PeopleList.fromJson));
  }

  Future<PeopleList> deletePerson(String id) => _people(_parse(_object(_personUri(id), _delete), PeopleList.fromJson));

  Future<PeopleList> undoPeople({String? batchId}) {
    return _people(_parse(_object(_uri('/api/v1/people/undo'), (uri) => _post(uri, {'batchId': ?batchId})), PeopleList.fromJson));
  }

  Uri _personUri(String id) => _uri('/api/v1/people/${Uri.encodeComponent(id)}');

  /// A server from before People answers 404 with an HTML page.
  Future<T> _people<T>(Future<T> call) async {
    try {
      return await call;
    } on ApiException catch (error) {
      if (error.status == 404 && !error.message.contains('Person') && !error.message.contains('undo')) {
        throw const ApiException(404, 'This Ledger server does not have Your people yet. Update it to manage people from the phone.');
      }
      rethrow;
    }
  }

  Future<LoanList> loans() => _loans(_parse(_object(_uri('/api/v1/loans'), _get), LoanList.fromJson));

  Future<LedgerLoan> createLoan(LoanDraft draft) {
    return _loans(_parse(_object(_uri('/api/v1/loans'), (uri) => _post(uri, draft.toJson())), LedgerLoan.fromJson));
  }

  Future<LedgerLoan> updateLoan(String id, LoanDraft draft) {
    return _loans(_parse(_object(_loanUri(id), (uri) => _patch(uri, draft.toJson())), LedgerLoan.fromJson));
  }

  /// `status` is "closed" (paid off) or "open".
  Future<LedgerLoan> setLoanStatus(String id, String status) {
    return _loans(_parse(_object(_loanUri(id), (uri) => _patch(uri, {'status': status})), LedgerLoan.fromJson));
  }

  Uri _loanUri(String id) => _uri('/api/v1/loans/${Uri.encodeComponent(id)}');

  /// A server from before loans answers 404 with an HTML page.
  Future<T> _loans<T>(Future<T> call) async {
    try {
      return await call;
    } on ApiException catch (error) {
      if (error.status == 404 && !error.message.contains('Loan')) {
        throw const ApiException(404, 'This Ledger server does not have Loans yet. Update it to add loans from the phone.');
      }
      rethrow;
    }
  }

  Future<Map<String, dynamic>> uploadSms({required String sender, required String body, DateTime? receivedAt, String? sourceId}) {
    return _object(
      _uri('/api/v1/alerts/sms'),
      (uri) => _post(uri, {
        'sender': sender,
        'body': body,
        'receivedAt': ?receivedAt?.toUtc().toIso8601String(),
        'sourceId': ?sourceId,
      }),
    );
  }

  Future<Map<String, dynamic>> alertStatus() => _object(_uri('/api/v1/alerts/status'), _get);

  Future<Map<String, dynamic>> syncAlerts() => _object(_uri('/api/v1/alerts/sync'), (uri) => _post(uri, const {}));

  Future<Map<String, dynamic>> alertParsers() => _object(_uri('/api/v1/alerts/parsers'), _get);

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

  Future<http.Response> _post(Uri uri, Map<String, Object?> body) {
    return _http.post(uri, headers: _headers(json: true), body: jsonEncode(body)).timeout(_timeout);
  }

  Future<http.Response> _delete(Uri uri) => _http.delete(uri, headers: _headers()).timeout(_timeout);

  Future<http.Response> _patch(Uri uri, Map<String, Object?> body) {
    return _http.patch(uri, headers: _headers(json: true), body: jsonEncode(body)).timeout(_timeout);
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
