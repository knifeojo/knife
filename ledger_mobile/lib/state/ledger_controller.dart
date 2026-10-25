import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../api/client.dart';
import '../api/models.dart';
import '../server_url.dart';
import '../storage/settings_store.dart';

class LedgerController extends ChangeNotifier {
  LedgerController(this.store, {http.Client? httpClient})
    : _http = httpClient ?? http.Client(),
      _ownsClient = httpClient == null;

  final SettingsStore store;
  final http.Client _http;
  final bool _ownsClient;

  bool ready = false;
  String? serverUrl;
  String? token;
  UserProfile? user;

  bool get signedIn => token != null;

  @override
  void dispose() {
    if (_ownsClient) _http.close();
    super.dispose();
  }

  Future<void> load() async {
    serverUrl = await store.getString(SettingsStore.serverUrlKey);
    token = await store.getString(SettingsStore.tokenKey);
    ready = true;
    notifyListeners();
  }

  Future<String?> connect(String raw) async {
    final error = validateServerUrl(raw);
    if (error != null) return error;
    final url = normalizeServerUrl(raw);
    try {
      final ok = await LedgerApi(baseUrl: url, httpClient: _http).health();
      if (!ok) return 'That server did not identify itself as Ledger.';
    } on ApiException catch (error) {
      return error.message;
    }
    if (serverUrl != url) {
      token = null;
      user = null;
      await store.remove(SettingsStore.tokenKey);
    }
    serverUrl = url;
    await store.setString(SettingsStore.serverUrlKey, url);
    notifyListeners();
    return null;
  }

  Future<String?> signIn({required String email, required String password, String? name, required bool createAccount}) async {
    try {
      final session = createAccount
          ? await _api().signup(email: email, password: password, name: name)
          : await _api().login(email: email, password: password);
      token = session.token;
      user = session.user;
      await store.setString(SettingsStore.tokenKey, session.token);
      notifyListeners();
      return null;
    } on ApiException catch (error) {
      return error.message;
    }
  }

  Future<void> signOut() async {
    final current = token;
    final url = serverUrl;
    token = null;
    user = null;
    await store.remove(SettingsStore.tokenKey);
    notifyListeners();
    if (current != null && url != null) {
      try {
        await LedgerApi(baseUrl: url, token: current, httpClient: _http).logout();
      } on ApiException {
        // The phone is already signed out. The token expires on its own if revoke failed.
      }
    }
  }

  Future<void> forgetServer() async {
    await signOut();
    serverUrl = null;
    await store.remove(SettingsStore.serverUrlKey);
    notifyListeners();
  }

  Future<HomeSummary> summary({int offset = 0}) => _guard((api) => api.summary(offset: offset));

  Future<AccountList> accounts() => _guard((api) => api.accounts());

  Future<TransactionPage> transactions({String? category, String? query, String? cadence, String? payee, String? type, String? from, String? to}) {
    return _guard((api) => api.transactions(category: category, query: query, cadence: cadence, payee: payee, type: type, from: from, to: to));
  }

  Future<ReviewQueue> review() => _guard((api) => api.review());

  Future<int> answerReview({required String kind, required String key, required String value, String? otherText, String? otherCategory}) {
    return _guard((api) => api.answerReview(kind: kind, key: key, value: value, otherText: otherText, otherCategory: otherCategory));
  }

  Future<int> answerSuggestion({required String id, required String action}) => _guard((api) => api.answerSuggestion(id: id, action: action));

  Future<AiStatus> aiStatus() => _guard((api) => api.aiStatus());

  Future<AiStatus> setAiEnabled(bool enabled) => _guard((api) => api.setAiEnabled(enabled));

  Future<AiStatus> setAiRoutes(Map<String, String> routes) => _guard((api) => api.setAiRoutes(routes));

  Future<CategorizeResult> rerunCategorization() => _guard((api) => api.rerunCategorization());

  Future<AffordabilityCheck> affordability({required String amountMinor, String? description, String horizon = 'month_end', String? bufferMinor}) {
    return _guard((api) => api.affordability(amountMinor: amountMinor, description: description, horizon: horizon, bufferMinor: bufferMinor));
  }

  Future<LoanList> loans() => _guard((api) => api.loans());

  /// Adds a loan, or saves an edit when [id] is set.
  Future<LedgerLoan> saveLoan(LoanDraft draft, {String? id}) {
    return _guard((api) => id == null ? api.createLoan(draft) : api.updateLoan(id, draft));
  }

  Future<LedgerLoan> setLoanStatus(String id, String status) => _guard((api) => api.setLoanStatus(id, status));

  Future<List<StatementFileResult>> upload({required String filename, required Uint8List bytes, String? password}) {
    return _guard((api) => api.uploadStatement(filename: filename, bytes: bytes, password: password));
  }

  LedgerApi _api() {
    final url = serverUrl;
    if (url == null) throw StateError('No server URL');
    return LedgerApi(baseUrl: url, token: token, httpClient: _http);
  }

  Future<T> _guard<T>(Future<T> Function(LedgerApi api) call) async {
    try {
      return await call(_api());
    } on ApiException catch (error) {
      if (error.status == 401) await signOut();
      rethrow;
    }
  }
}
