import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/loans/cleared_notice.dart';

class _FakeNotice implements LoanNoticePlatform {
  final calls = <String>[];
  String result = 'shown';

  @override
  Future<String> show(String id, String text) async {
    calls.add('$id|$text');
    return result;
  }
}

void main() {
  test('notice text uses whole naira and the gate fires once', () async {
    expect(
      loanClearedNotice('Renmoney', '1850000'),
      'Renmoney is fully paid. That frees up about ₦18,500 a month.',
    );
    expect(
      loanClearedNotice('FairMoney', '1850050'),
      'FairMoney is fully paid. That frees up about ₦18,500.50 a month.',
    );

    final platform = _FakeNotice();
    final gate = LoanNoticeGate(platform);
    const event = (id: 'evt-1', lender: 'Renmoney', freedMinor: '12000000');
    await gate.announce([event]);
    await gate.announce([event]);
    expect(platform.calls, ['evt-1|Renmoney is fully paid. That frees up about ₦120,000 a month.']);

    platform.result = 'failed';
    await gate.announce([(id: 'evt-2', lender: 'Carbon', freedMinor: '1000000')]);
    await gate.announce([(id: 'evt-2', lender: 'Carbon', freedMinor: '1000000')]);
    expect(platform.calls.where((call) => call.startsWith('evt-2|')), hasLength(2));
  });
}
