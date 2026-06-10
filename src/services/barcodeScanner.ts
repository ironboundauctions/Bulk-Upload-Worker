import sharp from 'sharp';
import jsQR from 'jsqr';
import Quagga from '@ericblade/quagga2';
import { logger } from '../logger.js';

export interface BarcodeResult {
  fileName: string;
  assetGroupId: string;
  barcodeValue?: string;
  error?: string;
}

export class BarcodeScanner {
  async scanBuffer(buffer: Buffer, fileName: string, assetGroupId: string): Promise<BarcodeResult> {
    try {
      const strategies = [
        {
          name: 'mega-upscale-sharp',
          process: (buf: Buffer) =>
            sharp(buf)
              .resize({ width: 3000, fit: 'inside' })
              .grayscale()
              .normalise()
              .sharpen({ sigma: 3 })
              .linear(2.0, -128)
              .toBuffer(),
        },
      ];

      for (const strategy of strategies) {
        try {
          const processedBuffer = await strategy.process(buffer);

          const { data, info } = await sharp(processedBuffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          const imageData = new Uint8ClampedArray(data);

          const qrResult = jsQR(imageData, info.width, info.height, {
            inversionAttempts: 'dontInvert',
          });

          if (qrResult) {
            logger.info('QR code detected via jsQR', { fileName, assetGroupId, barcodeValue: qrResult.data });
            return { fileName, assetGroupId, barcodeValue: qrResult.data.trim() };
          }

          try {
            const pngBuffer = await sharp(processedBuffer).png().toBuffer();
            const base64 = pngBuffer.toString('base64');
            const dataUrl = `data:image/png;base64,${base64}`;

            const result = await new Promise<any>((resolve, reject) => {
              Quagga.decodeSingle(
                {
                  src: dataUrl,
                  numOfWorkers: 0,
                  locate: true,
                  decoder: {
                    readers: [
                      'code_128_reader',
                      'code_39_reader',
                      'code_93_reader',
                      'ean_reader',
                      'upc_reader',
                      'codabar_reader',
                      'i2of5_reader',
                    ] as any,
                  },
                },
                (res: any) => {
                  if (res && res.codeResult) {
                    resolve(res);
                  } else {
                    reject(new Error('No barcode found'));
                  }
                }
              );
            });

            if (result && result.codeResult && result.codeResult.code) {
              const barcodeValue = result.codeResult.code.trim();
              logger.info('Barcode detected via Quagga2', { fileName, assetGroupId, barcodeValue });
              return { fileName, assetGroupId, barcodeValue };
            }
          } catch {
            // No barcode found with this strategy
          }
        } catch (detectionError) {
          logger.warn(`Detection error with strategy ${strategy.name}`, {
            fileName,
            error: detectionError instanceof Error ? detectionError.message : String(detectionError),
          });
        }
      }

      // jsQR fallback on raw pixels
      const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const qrFallback = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
        inversionAttempts: 'attemptBoth',
      });

      if (qrFallback && qrFallback.data) {
        logger.info('QR code detected via jsQR fallback', { fileName, assetGroupId, barcodeValue: qrFallback.data });
        return { fileName, assetGroupId, barcodeValue: qrFallback.data.trim() };
      }

      logger.debug('No barcode found in image', { fileName, assetGroupId });
      return { fileName, assetGroupId };
    } catch (error) {
      logger.warn('Error scanning image for barcode', {
        fileName,
        assetGroupId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { fileName, assetGroupId };
    }
  }
}
