const { pdf } = require('pdf-to-img');
const { createWorker } = require('tesseract.js');
const axios = require('axios');
const llmConfig = require('../llmConfig.json');

/**
 * 長文テキストを指定文字数ごとに分割するヘルパー関数
 */
function chunkText(text, chunkSize = 4000) {
  const chunks = [];
  let index = 0;
  while (index < text.length) {
    chunks.push(text.slice(index, index + chunkSize));
    index += chunkSize;
  }
  return chunks;
}

/**
 * 画像PDFからOCRでテキストを抽出し、分割要約を経て最終サマリーを生成する
 * @param {Buffer} pdfBuffer
 * @param {Function} onProgress 進捗イベント通知用コールバック (percent, message)
 */
async function processImagePdfAndSummarize(pdfBuffer, onProgress = () => {}) {
  // 1. PDFバッファをページ画像ストリームに変換
  onProgress(5, 'PDFを画像データに変換中...');
  console.log('PDFを画像に変換中...');
  const document = await pdf(pdfBuffer, { scale: 2.0 });

  // 2. Tesseractワーカー初期化
  onProgress(10, 'OCRエンジンを初期化中...');
  const worker = await createWorker('jpn');
  let fullExtractedText = '';
  let pageIndex = 1;

  // 3. ページごとにOCR処理
  for await (const image of document) {
    onProgress(15, `Page ${pageIndex} をOCR解析中...`);
    console.log(`Page ${pageIndex} をOCR解析中...`);
    const ret = await worker.recognize(image);

    fullExtractedText += `\n--- Page ${pageIndex} ---\n` + ret.data.text;
    pageIndex++;
  }

  await worker.terminate();

  if (!fullExtractedText.trim()) {
    throw new Error('画像PDFからテキストを検出できませんでした。');
  }

  // 4. テキストを約4,000文字単位で分割
  const chunks = chunkText(fullExtractedText, 4000);
  const intermediateSummaries = [];

  // 5. 各チャンクごとに個別にOllamaへ投げて部分要約（Mapフェーズ）
  for (let i = 0; i < chunks.length; i++) {
    // 25% 〜 80% の間で進捗を割り当て
    const percent = Math.floor(25 + ((i + 1) / chunks.length) * 55);
    onProgress(percent, `パーツ ${i + 1} / ${chunks.length} をAI分析中...`);

    const response = await axios.post(
      `${llmConfig.ollamaHost}/api/chat`,
      {
        model: llmConfig.model,
        messages: [
          {
            role: 'system',
            content: 'あなたは医療アシスタントです。提出された文章の重要情報を漏らさず完璧に抽出してください。'
          },
          {
            role: 'user',
            content: `以下はOCR抽出した長文ドキュメントのパート${i + 1}です。作成してください：\n\n${chunks[i]}`
          }
        ],
        options: { num_ctx: 8192 },
        stream: false
      },
      { timeout: 0 } // ★ タイムアウト無制限化
    );

    intermediateSummaries.push(response.data.message.content);
  }

  let finalSummary = intermediateSummaries[0];

  // 6. 結合処理（Reduceフェーズ）
  if (intermediateSummaries.length > 1) {
    onProgress(85, '分割した要約を統合し、最終サマリーを作成中...');

    const combinedSummaryText = intermediateSummaries
      .map((sum, idx) => `【パート${idx + 1}の要約】\n${sum}`)
      .join('\n\n');

    const finalResponse = await axios.post(
      `${llmConfig.ollamaHost}/api/chat`,
      {
        model: llmConfig.model,
        messages: [
          {
            role: 'system',
            content: llmConfig.ocrSystemPrompt || llmConfig.systemPrompt
          },
          {
            role: 'user',
            content: `${llmConfig.userPromptTemplate}\n\n以下は各章の要約一覧です。これらを統合し、時系列や医療経過が分か
る最終サマリーを作成してください：\n\n${combinedSummaryText}`
          }
        ],
        options: { num_ctx: 16384 },
        stream: false
      },
      { timeout: 0 } // ★ タイムアウト無制限化
    );

    finalSummary = finalResponse.data.message.content;
  }

  onProgress(100, '処理完了');

  return {
    totalPages: pageIndex - 1,
    summary: finalSummary
  };
}

module.exports = {
  processImagePdfAndSummarize
};
