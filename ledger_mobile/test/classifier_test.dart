import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/alerts/classifier.dart';

const _gt = 'Acct:******1234\nAmt:NGN3,450.00 DR\nDesc:POS PURCHASE\nBal:NGN10,000.00';
const _ren =
    'Credit of NGN15,000.00 into wallet ****4821. Avl Bal: NGN27,430.50. Desc: WALLET FUNDING FROM EMPLOYER';

void main() {
  test('scores synthetic financial texts and rejects OTP, promo, and chats', () {
    final gt = classifyFinancialSms('GTBank', _gt);
    expect(gt.reason, 'financial');
    expect(gt.score, 11);
    expect(senderAction('GTBank', _gt), SenderAction.upload);

    final ren = classifyFinancialSms('Renmoney', _ren);
    expect(ren.reason, 'financial');
    expect(ren.score, 10);
    expect(senderAction('Renmoney', _ren), SenderAction.ask);
    expect(senderAction('Renmoney', _ren, approved: {'renmoney'}), SenderAction.upload);
    expect(senderAction('Renmoney', _ren, denied: {'renmoney'}), SenderAction.drop);

    expect(
      classifyFinancialSms('GTBank', 'Your OTP is 482193. Do not share this code with anyone.').reason,
      'otp',
    );
    expect(
      classifyFinancialSms('Renmoney', 'Your verification code is 849201. It expires in 5 minutes.').reason,
      'otp',
    );
    expect(
      classifyFinancialSms(
        'GTBank',
        'Congratulations! You have a loan offer up to N300,000. Dial *894*11#',
      ).reason,
      'promo',
    );
    expect(
      classifyFinancialSms('MTN', 'Congratulations! You have won N500,000. Dial *123# to claim.').reason,
      'telco',
    );
    expect(
      classifyFinancialSms('Airtel', 'promo').reason,
      'telco',
    );
    expect(
      classifyFinancialSms('+2348012345678', 'I sent you NGN5,000 for lunch').reason,
      'personal',
    );
    expect(classifyFinancialSms('08031234567', 'See you at 6').reason, 'personal');
    expect(
      classifyFinancialSms('Renmoney', 'Hello, your statement is ready in the app').reason,
      'low_score',
    );

    const loan =
        'Renmoney: Your loan outstanding balance is NGN150,000.00. Instalment 3 of 12. Amount due NGN18,500.00. Due date 15 Nov 2026.';
    final status = classifyFinancialSms('Renmoney', loan);
    expect(status.reason, 'loan_status');
    expect(status.financial, isTrue);
    expect(senderAction('Renmoney', loan, approved: {'renmoney'}), SenderAction.upload);
    expect(
      classifyFinancialSms(
        'Renmoney',
        'Debit of NGN18,500.00 from ****4821. Bal: NGN200,000.00. Desc: LOAN REPAYMENT',
      ).reason,
      'financial',
    );

    final realDebit = classifyFinancialSms(
      'FirstBank',
      'Debit: 301XXXX123 Amt: NGN12,500.00 Desc: POS SHOP Bal: NGN41,280.44CR. Dial *894*11# to get loan',
    );
    expect(realDebit.reason, 'financial');
    expect(realDebit.financial, isTrue);
  });
}
