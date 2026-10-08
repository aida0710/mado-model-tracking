// The "connect from MLflow 3" card on the Project settings page.
export const connectionText = {
  mlflowConnection: 'MLflow 3から接続',
  mlflowConnectionIssueToken: 'このProject用のAPI tokenを発行',
  mlflowConnectionEnvironment: '環境変数（tokenは実行時に入力）',
  mlflowConnectionMore: 'Pythonの例・Basic認証',
  mlflowConnectionServiceAccountHint:
    '長期の自動処理やworkerには、Service Accountのtokenを使ってください。SSOユーザーのtokenは、グループの確認から7日を過ぎると止まります。',
  mlflowConnectionPython: 'Pythonの最小例',
  mlflowConnectionBasic: 'Basic認証（ユーザー名とパスワードを使うツール。passwordにtoken）',
} as const;
