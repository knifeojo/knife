import 'package:flutter/services.dart';

import '../format.dart';

/// "Renmoney is fully paid. That frees up about ₦18,500 a month." Whole naira drops the ".00".
String loanClearedNotice(String lender, String freedMinor) {
  final shown = formatMinor(freedMinor);
  final amount = shown.endsWith('.00') ? shown.substring(0, shown.length - 3) : shown;
  return '$lender is fully paid. That frees up about $amount a month.';
}

/// `shown` the first time, `duplicate` when this id was already announced, `failed` to retry later.
abstract class LoanNoticePlatform {
  Future<String> show(String id, String text);
}

class MethodChannelLoanNotice implements LoanNoticePlatform {
  MethodChannelLoanNotice({MethodChannel? channel}) : _channel = channel ?? const MethodChannel('ledger/update');

  final MethodChannel _channel;

  @override
  Future<String> show(String id, String text) async {
    try {
      final raw = await _channel.invokeMethod<Object?>('showNotice', {'id': id, 'text': text});
      if (raw == 'shown' || raw == 'duplicate' || raw == 'failed') return raw as String;
      return 'failed';
    } on MissingPluginException {
      return 'failed';
    } on PlatformException {
      return 'failed';
    }
  }
}

/// Announces each cleared loan once per id. A failed post is tried again on the next pass.
class LoanNoticeGate {
  LoanNoticeGate(this.platform, {Set<String>? announced}) : announced = announced ?? <String>{};

  final LoanNoticePlatform platform;
  final Set<String> announced;

  Future<void> announce(Iterable<({String id, String lender, String freedMinor})> events) async {
    for (final event in events) {
      if (announced.contains(event.id)) continue;
      final result = await platform.show(event.id, loanClearedNotice(event.lender, event.freedMinor));
      if (result != 'failed') announced.add(event.id);
    }
  }
}
