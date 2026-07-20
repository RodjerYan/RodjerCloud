import { Api } from 'telegram/tl'
console.log(Object.keys(new Api.upload.GetFile({ location: new Api.InputDocumentFileLocation({ id: BigInt(1), accessHash: BigInt(1), fileReference: Buffer.from([]), thumbSize: '' }), offset: BigInt(0), limit: 1024 })))
