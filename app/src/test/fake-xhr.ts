/**
 * A minimal fake standing in for `XMLHttpRequest` — real `XMLHttpRequest` +
 * jsdom's `File`/`FormData` don't survive MSW's Node-side multipart
 * interception intact (a jsdom `File` fails Undici's `webidl.is.File`
 * brand check), so `uploadFile`'s `createXhr` test seam drives this
 * directly instead. Shared by `api/upload.test.ts` and the sources feature's
 * upload tests.
 */
export class FakeXhr extends EventTarget {
  upload = new EventTarget();
  status = 0;
  responseText = '';
  responseURL = '';
  aborted = false;
  sentBody: FormData | undefined;
  headers: Record<string, string> = {};

  open(_method: string, url: string): void {
    this.responseURL = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: FormData): void {
    this.sentBody = body;
  }

  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
  }

  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.dispatchEvent(new Event('load'));
  }

  progress(loaded: number, total: number): void {
    const event = new Event('progress') as Event & {
      loaded: number;
      total: number;
      lengthComputable: boolean;
    };
    event.loaded = loaded;
    event.total = total;
    event.lengthComputable = true;
    this.upload.dispatchEvent(event);
  }

  networkError(): void {
    this.dispatchEvent(new Event('error'));
  }
}
