const express = require('express');
const router = express.Router();
const multer = require('multer');

const summaryService = require('../services/summaryService');
const ocrSummaryService = require('../services/ocrSummaryService');
const chatService = require('../services/chatService');

const upload = multer({ storage: multer.memoryStorage() });

// PDFアップロード ＆ 要約API
router.post('/summarize-pdf', upload.single('pdf'), async (req, res) => {

    if (!req.file) {
      return res.status(400).json({ error: 'PDFファイルがアップロードされていません。' });
    }

    // SSE (Server-Sent Events) のレスポンスヘッダー設定
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginxを使用している場合のバッファリング無効化

// クライアントに進捗イベントを送信するヘルパー関数
  const sendEvent = (percent, message, result = null) => {

	  // ★ メッセージ内の改行コードを除去してSSE構文崩れを防ぐ
    const safeMessage = typeof message === 'string' ? message.replace(/[\r\n]+/g, ' ') : message;

    res.write(`data: ${JSON.stringify({ percent, message, filename: req.file.originalname, ...result })}\n\n`);
  };

try{

    const result = await summaryService.processPdfAndSummarize(
            req.file.buffer,
        (percent, message) => {
        sendEvent(percent, message);
      }
    );

    // 処理完了時に最終結果を送信して通信を終了
    sendEvent(100, '処理完了', {
      totalPages: result.totalPages,
      summary: result.summary
    });
    res.end();

  } catch (error) {
    console.error('APIエラー:', error);
    res.status(500).json({ error: error.message || '処理中にエラーが発生しました。' });
  }
});

// 画像PDF (OCR) 用エンドポイント (SSE対応)
router.post('/summarize-image-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルが選択されていません。' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (percent, message, result = null) => {
    res.write(`data: ${JSON.stringify({ percent, message, filename: req.file.originalname, ...result })}\n\n`);
  };

  try {
    const result = await ocrSummaryService.processImagePdfAndSummarize(
      req.file.buffer,
      (percent, message) => {
        sendEvent(percent, message);
      }
    );

    sendEvent(100, '処理完了', {
      totalPages: result.totalPages,
      summary: result.summary
    });
    res.end();

  } catch (error) {
    console.error('OCR APIエラー:', error);
    sendEvent(-1, `エラーが発生しました: ${error.message || 'OCR処理中にエラーが発生しました。'}`);
    res.end();
  }
});

router.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'メッセージ履歴が正しく送信されていません。' });
    }

    const reply = await chatService.sendChatMessage(messages);

    res.json({ reply });
  } catch (error) {
    console.error('チャットAPIエラー:', error);
    res.status(500).json({ error: error.message || 'AIの応答作成中にエラーが発生しました。' });
  }

});

module.exports = router;
