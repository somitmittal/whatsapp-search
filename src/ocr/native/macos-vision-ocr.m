#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <PDFKit/PDFKit.h>
#import <AppKit/AppKit.h>

static void recognizeCGImage(CGImageRef cgImage, NSString *prefix) {
    if (!cgImage) return;
    @autoreleasepool {
        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = YES;
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];
        NSError *err = nil;
        [handler performRequests:@[request] error:&err];
        if (!err && request.results) {
            for (VNRecognizedTextObservation *obs in request.results) {
                VNRecognizedText *top = [[obs topCandidates:1] firstObject];
                if (top && [top.string length] > 0) {
                    if (prefix) {
                        printf("%s%s\n", [prefix UTF8String], [top.string UTF8String]);
                    } else {
                        printf("%s\n", [top.string UTF8String]);
                    }
                }
            }
        }
    }
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "Usage: macos-vision-ocr <file-path>\n");
            return 1;
        }

        NSString *path = [NSString stringWithUTF8String:argv[1]];
        NSURL *url = [NSURL fileURLWithPath:path];
        if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
            return 1;
        }

        NSString *lower = [path lowercaseString];
        if ([lower hasSuffix:@".pdf"]) {
            PDFDocument *pdf = [[PDFDocument alloc] initWithURL:url];
            if (!pdf) return 2;
            NSUInteger count = [pdf pageCount];
            NSUInteger maxPages = count > 15 ? 15 : count;

            for (NSUInteger i = 0; i < maxPages; i++) {
                @autoreleasepool {
                    PDFPage *page = [pdf pageAtIndex:i];
                    if (!page) continue;

                    NSString *plain = [[page string] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                    if (plain && [plain length] > 50) {
                        printf("[Page %lu]\n%s\n\n", (unsigned long)(i + 1), [plain UTF8String]);
                        continue;
                    }

                    // Scanned or image-based PDF page: render and run Apple Vision OCR
                    NSRect bounds = [page boundsForBox:kPDFDisplayBoxMediaBox];
                    CGFloat scale = 2.0;
                    NSSize renderSize = NSMakeSize(bounds.size.width * scale, bounds.size.height * scale);
                    NSImage *image = [[NSImage alloc] initWithSize:renderSize];
                    [image lockFocus];
                    CGContextRef context = [[NSGraphicsContext currentContext] CGContext];
                    CGContextScaleCTM(context, scale, scale);
                    [page drawWithBox:kPDFDisplayBoxMediaBox toContext:context];
                    [image unlockFocus];

                    CGImageRef cgImage = [image CGImageForProposedRect:NULL context:NULL hints:NULL];
                    if (cgImage) {
                        printf("[Page %lu]\n", (unsigned long)(i + 1));
                        recognizeCGImage(cgImage, nil);
                        printf("\n");
                    }
                }
            }
            return 0;
        }

        // Standard image file (jpg, png, webp, heic, etc.)
        NSImage *image = [[NSImage alloc] initWithContentsOfURL:url];
        if (!image) return 3;
        CGImageRef cgImage = [image CGImageForProposedRect:NULL context:NULL hints:NULL];
        if (!cgImage) return 4;

        recognizeCGImage(cgImage, nil);
        return 0;
    }
}
