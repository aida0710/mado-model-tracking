import { text } from '../i18n/catalog';

/**
 * 重なった3枚の層の印。上の層は強調色、下の2枚は文字と同じ色で、記録が版として積み重なる様子を表す。
 * 形はブラウザのタブのアイコン（public/favicon.svg）と同じ。色と大きさは styles/productLogo.css の .product-mark。
 */
export function TrackingMark() {
  return (
    <svg className="product-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="product-mark-layer" d="M3 12.25L12 16.75L21 12.25" />
      <path className="product-mark-layer" d="M3 16.75L12 21.25L21 16.75" />
      <path className="product-mark-top" d="M12 2.75L21 7.25L12 11.75L3 7.25Z" />
    </svg>
  );
}

/**
 * 製品のロゴ。印と「mado ML Tracking」を並べる。mado の各製品と同じく、前の mado は通常の太さ、
 * 製品の部分は太字にする。上部バー・ドロワー・ログイン画面で同じ組み方にそろえる。
 */
export function ProductLogo() {
  return (
    <span className="product-logo">
      <TrackingMark />
      <span>
        <span className="product-prefix">{text.appNamePrefix}</span>{' '}
        <strong>{text.appNameProduct}</strong>
      </span>
    </span>
  );
}
