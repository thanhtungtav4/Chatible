/**
 * Client-side Pre-upload Image Compressor
 * Enforces Constitutional Decision D31: Compresses images to WebP (< 800KB, max 1920px)
 * Saves 90%+ bandwidth and CPU on single-node server.
 */

export interface CompressionResult {
  file: File;
  originalSize: number;
  compressedSize: number;
  width: number;
  height: number;
  compressionRatio: string;
}

export class ImageCompressor {
  /**
   * Compresses an image File to WebP with dimensions scaled within max 1920px.
   */
  static async compress(
    imageFile: File,
    maxDimension: number = 1920,
    quality: number = 0.82
  ): Promise<CompressionResult> {
    if (!imageFile.type.startsWith('image/')) {
      throw new Error('Tệp tải lên không phải là định dạng hình ảnh hợp lệ.');
    }

    // Check maximum raw upload limit (30 MB according to MEDIA-07)
    const MAX_RAW_BYTES = 30_000_000;
    if (imageFile.size >= MAX_RAW_BYTES) {
      throw new Error('Dung lượng ảnh phải nhỏ hơn 30 MB.');
    }

    const { promise, resolve, reject } = Promise.withResolvers<CompressionResult>();
    const img = new Image();
    const reader = new FileReader();

      reader.onload = (e) => {
        img.src = e.target?.result as string;
      };

      reader.onerror = () => reject(new Error('Lỗi khi đọc tệp ảnh.'));

      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          const scale = maxDimension / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const encode = (targetWidth: number, targetHeight: number, targetQuality: number) =>
          new Promise<Blob>((resolveBlob, rejectBlob) => {
            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const context = canvas.getContext('2d');
            if (!context) {
              rejectBlob(new Error('Không thể khởi tạo Canvas 2D context.'));
              return;
            }
            context.drawImage(img, 0, 0, targetWidth, targetHeight);
            canvas.toBlob(
              (blob) => blob ? resolveBlob(blob) : rejectBlob(new Error('Nén ảnh thất bại.')),
              'image/webp',
              targetQuality
            );
          });

        void (async () => {
          const MIN_TARGET_BYTES = 300 * 1024;
          const MAX_TARGET_BYTES = 800 * 1024;
          const minUsefulBytes = Math.min(MIN_TARGET_BYTES, imageFile.size);
          let outputWidth = width;
          let outputHeight = height;
          let outputQuality = quality;

          for (let attempt = 0; attempt < 24; attempt++) {
            const blob = await encode(outputWidth, outputHeight, outputQuality);
            const compressedFile = new File(
              [blob],
              imageFile.name.replace(/\.[^/.]+$/, '') + '.webp',
              { type: 'image/webp' }
            );
            if (compressedFile.size <= MAX_TARGET_BYTES && compressedFile.size >= minUsefulBytes) {
              resolve({
                file: compressedFile,
                originalSize: imageFile.size,
                compressedSize: compressedFile.size,
                width: outputWidth,
                height: outputHeight,
                compressionRatio: ((1 - compressedFile.size / imageFile.size) * 100).toFixed(1) + '%',
              });
              return;
            }
            if (compressedFile.size > MAX_TARGET_BYTES) {
              if (outputQuality > 0.5) {
                outputQuality = Math.max(0.45, outputQuality - 0.1);
              } else {
                outputWidth = Math.max(1, Math.round(outputWidth * 0.85));
                outputHeight = Math.max(1, Math.round(outputHeight * 0.85));
                outputQuality = quality;
              }
              continue;
            }
            if (outputQuality < 0.95) {
              outputQuality = Math.min(0.95, outputQuality + 0.05);
              continue;
            }
            // Small or visually simple originals need not be inflated to meet the lower target.
            resolve({
              file: compressedFile,
              originalSize: imageFile.size,
              compressedSize: compressedFile.size,
              width: outputWidth,
              height: outputHeight,
              compressionRatio: ((1 - compressedFile.size / imageFile.size) * 100).toFixed(1) + '%',
            });
            return;
          }
          reject(new Error('Không thể nén ảnh xuống dưới 800 KB.'));
        })().catch(reject);
      };

      img.onerror = () => reject(new Error('Tệp ảnh bị lỗi hoặc không hỗ trợ giải mã.'));
      reader.readAsDataURL(imageFile);
    return promise;
  }
}
