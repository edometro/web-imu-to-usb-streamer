
# Web IMU to USB Serial Streamer 🚀

デバイスのIMU（慣性計測装置）データを取得し、Web Serial APIを使用して接続されたUSBデバイスへ送信するダッシュボードです。

## ⚠️ スマホで動かない場合の理由

スマホのブラウザでは、**HTTPS接続**が必須です。
- ❌ `file:///...` でHTMLを開く（センサーがロックされます）
- ❌ `http://192.168.x.x` でPCにアクセスする（同上）
- ✅ `https://あなたのユーザー名.github.io/...` （動作します！）

## GitHub Pages で公開する方法

1. GitHubに新しいリポジトリを作ってコードをアップロード（Push）します。
2. ターミナルで以下を実行します。
   ```bash
   npm run deploy
   ```
3. GitHubリポジトリの設定（Settings > Pages）で、Sourceが `gh-pages` ブランチになっていることを確認します。
4. 数分待つと、`https://...` で始まるURLが発行され、スマホでもセンサーが使えるようになります。

## セットアップ（PC開発用）

### 1. 準備
```bash
npm install
```

### 2. APIキー
`.env` ファイルに Gemini APIキーを記述してください。
```text
VITE_API_KEY=あなたのキー
```

### 3. 実行
```bash
npm run dev
```

## 注意事項
- **iOS**: SafariはWeb Serial APIに非対応なため、USB転送はできません（センサー表示とAI解析は可能）。
- **Android**: ChromeでUSB OTG接続すれば動作する可能性があります。
