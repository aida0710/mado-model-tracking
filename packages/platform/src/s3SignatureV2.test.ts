import { describe, expect, it } from 'vitest';
import {
  canonicalizedResource,
  hostBucketOf,
  signatureV2Authorization,
  signS3RequestV2,
  stringToSign,
  type S3SignableRequest,
} from './s3SignatureV2.js';

// The example key pair published in the AWS documentation; it authenticates to nothing.
const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const bucket = 'awsexamplebucket1';
const virtualHost = 'awsexamplebucket1.s3.us-west-1.amazonaws.com';
const pathStyleHost = 's3.us-west-1.amazonaws.com';

function authorization(request: S3SignableRequest, pathStyle = false): string {
  const hostBucket = hostBucketOf({ hostname: request.hostname, bucket, pathStyle });
  return signatureV2Authorization({ request, credentials, ...(hostBucket ? { hostBucket } : {}) });
}

// Expected values are the Authorization headers of the "Authentication examples" in
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/RESTAuthentication.html
describe('署名v2: AWSの公開ドキュメントの例', () => {
  it('GET object（virtual-host）', () => {
    expect(
      authorization({
        method: 'GET',
        hostname: 'awsexamplebucket1.us-west-1.s3.amazonaws.com',
        path: '/photos/puppy.jpg',
        headers: { Date: 'Tue, 27 Mar 2007 19:36:42 +0000' },
      }),
    ).toBe('AWS AKIAIOSFODNN7EXAMPLE:qgk2+6Sv9/oM7G3qLEjTH1a1l1g=');
  });

  it('PUT object はContent-Typeを署名し、Content-Lengthは署名しない', () => {
    expect(
      authorization({
        method: 'PUT',
        hostname: virtualHost,
        path: '/photos/puppy.jpg',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': '94328',
          Date: 'Tue, 27 Mar 2007 21:15:45 +0000',
        },
      }),
    ).toBe('AWS AKIAIOSFODNN7EXAMPLE:iqRzw+ileNPu1fhspnRs8nOjjIA=');
  });

  it('list は prefix・max-keys・marker を署名しない', () => {
    expect(
      authorization({
        method: 'GET',
        hostname: virtualHost,
        path: '/',
        query: { prefix: 'photos', 'max-keys': '50', marker: 'puppy' },
        headers: { 'User-Agent': 'Mozilla/5.0', Date: 'Tue, 27 Mar 2007 19:42:41 +0000' },
      }),
    ).toBe('AWS AKIAIOSFODNN7EXAMPLE:m0WP8eCtspQl5Ahe6L1SozdX9YA=');
  });

  it('?acl は値なしのsubresourceとして署名する（SDKの "" と null のどちらでも）', () => {
    const request = (acl: string | null): S3SignableRequest => ({
      method: 'GET',
      hostname: virtualHost,
      path: '/',
      query: { acl },
      headers: { Date: 'Tue, 27 Mar 2007 19:44:46 +0000' },
    });
    const expected = 'AWS AKIAIOSFODNN7EXAMPLE:82ZHiFIjc+WbcwFKGUVEQspPn+0=';
    expect(authorization(request(''))).toBe(expected);
    expect(authorization(request(null))).toBe(expected);
  });

  it('CNAMEのbucket、Content-MD5、同名x-amz-metaの結合と小文字化', () => {
    const request: S3SignableRequest = {
      method: 'PUT',
      hostname: 'static.awsexamplebucket1.net',
      path: '/db-backup.dat.gz',
      headers: {
        'User-Agent': 'curl/7.15.5',
        Date: 'Tue, 27 Mar 2007 21:06:08 +0000',
        'x-amz-acl': 'public-read',
        'content-type': 'application/x-download',
        'Content-MD5': '4gJE4saaMU4BqNR0kLY+lw==',
        // A header bag cannot repeat a key, so the two ReviewedBy values differ only in case.
        'X-Amz-Meta-ReviewedBy': 'joe@awsexamplebucket1.net',
        'x-amz-meta-reviewedby': 'jane@awsexamplebucket1.net',
        'X-Amz-Meta-FileChecksum': '0x02661779',
        'X-Amz-Meta-ChecksumAlgorithm': 'crc32',
        'Content-Disposition': 'attachment; filename=database.dat',
        'Content-Encoding': 'gzip',
        'Content-Length': '5913339',
      },
    };
    const hostBucket = 'static.awsexamplebucket1.net';
    expect(stringToSign(request, hostBucket)).toBe(
      'PUT\n4gJE4saaMU4BqNR0kLY+lw==\napplication/x-download\nTue, 27 Mar 2007 21:06:08 +0000\n' +
        'x-amz-acl:public-read\nx-amz-meta-checksumalgorithm:crc32\n' +
        'x-amz-meta-filechecksum:0x02661779\n' +
        'x-amz-meta-reviewedby:joe@awsexamplebucket1.net,jane@awsexamplebucket1.net\n' +
        '/static.awsexamplebucket1.net/db-backup.dat.gz',
    );
    expect(signatureV2Authorization({ request, credentials, hostBucket })).toBe(
      'AWS AKIAIOSFODNN7EXAMPLE:dKZcB+bz2EPXgSdXZp9ozGeOM4I=',
    );
  });

  it('bucketを指さない list all my buckets は "/" を署名する', () => {
    expect(
      authorization({
        method: 'GET',
        hostname: pathStyleHost,
        path: '/',
        headers: { Date: 'Wed, 28 Mar 2007 01:29:59 +0000' },
      }),
    ).toBe('AWS AKIAIOSFODNN7EXAMPLE:qGdzdERIC03wnaRNKh6OqZehG9s=');
  });

  it('URLエンコード済みのpathは大文字小文字も含めてそのまま署名する', () => {
    expect(
      authorization({
        method: 'GET',
        hostname: pathStyleHost,
        path: '/dictionary/fran%C3%A7ais/pr%c3%a9f%c3%a8re',
        headers: { Date: 'Wed, 28 Mar 2007 01:49:49 +0000' },
      }),
    ).toBe('AWS AKIAIOSFODNN7EXAMPLE:DNEZGsoieTZ92F3bUfSPQcbGmlM=');
  });
});

describe('署名v2: x-amz-date', () => {
  // The documentation's Delete example puts the x-amz-date value in the Date position, which
  // contradicts its own rule ("use the empty string for the Date"). S3 follows the rule, so this
  // expects the rule; the signature was computed independently with Python's hmac module.
  it('x-amz-dateがあるとDateの位置を空にし、x-amz-dateをamzヘッダーとして署名する', () => {
    const request: S3SignableRequest = {
      method: 'DELETE',
      hostname: pathStyleHost,
      path: '/awsexamplebucket1/photos/puppy.jpg',
      headers: {
        'User-Agent': 'dotnet',
        Date: 'Tue, 27 Mar 2007 21:20:27 +0000',
        'x-amz-date': 'Tue, 27 Mar 2007 21:20:26 +0000',
      },
    };
    expect(stringToSign(request)).toBe(
      'DELETE\n\n\n\nx-amz-date:Tue, 27 Mar 2007 21:20:26 +0000\n' +
        '/awsexamplebucket1/photos/puppy.jpg',
    );
    expect(authorization(request, true)).toBe(
      'AWS AKIAIOSFODNN7EXAMPLE:Ri1hpB1zpS9pGqR7y8kuNFCl4sE=',
    );
  });
});

// Signatures computed independently with Python's hmac module from the string shown in each test.
describe('署名v2: multipartのsubresource', () => {
  const date = 'Tue, 27 Mar 2007 21:20:26 +0000';

  it('UploadPart は partNumber と uploadId を名前順に署名し、SDKの x-id は署名しない', () => {
    const request: S3SignableRequest = {
      method: 'PUT',
      hostname: virtualHost,
      path: '/photos/puppy.jpg',
      query: { uploadId: 'VXBsb2FkIElE', 'x-id': 'UploadPart', partNumber: '2' },
      headers: { Date: date, 'Content-Length': '5242880' },
    };
    expect(canonicalizedResource(request, bucket)).toBe(
      '/awsexamplebucket1/photos/puppy.jpg?partNumber=2&uploadId=VXBsb2FkIElE',
    );
    expect(authorization(request)).toBe('AWS AKIAIOSFODNN7EXAMPLE:JgqVfyhKirKmsjbgMMXL9KrV43Q=');
  });

  it('CreateMultipartUpload は ?uploads を値なしで署名する', () => {
    expect(
      authorization({
        method: 'POST',
        hostname: virtualHost,
        path: '/photos/puppy.jpg',
        query: { uploads: '', 'x-id': 'CreateMultipartUpload' },
        headers: { Date: date, 'Content-Type': 'application/octet-stream' },
      }),
    ).toBe('AWS AKIAIOSFODNN7EXAMPLE:hvS4YNfb9BRMikkD/70dL+Y8h9I=');
  });

  it('response-* と versionId の値はデコードしたまま名前順に署名する', () => {
    const request: S3SignableRequest = {
      method: 'GET',
      hostname: virtualHost,
      path: '/photos/puppy.jpg',
      query: { versionId: 'v 1', 'response-content-type': 'text/plain; charset=utf-8' },
      headers: { Date: date },
    };
    expect(canonicalizedResource(request, bucket)).toBe(
      '/awsexamplebucket1/photos/puppy.jpg?response-content-type=text/plain; charset=utf-8&versionId=v 1',
    );
    expect(authorization(request)).toBe('AWS AKIAIOSFODNN7EXAMPLE:i5e0bOw8v5Sum8Mkix33/cnOyV4=');
  });
});

describe('署名v2: path-style と virtual-host', () => {
  it('同じobjectは両方の形式で同じCanonicalizedResourceになる', () => {
    const virtual = { path: '/photos/puppy.jpg', query: { acl: '' } };
    const pathStyle = { path: '/awsexamplebucket1/photos/puppy.jpg', query: { acl: '' } };
    const hostBucket = hostBucketOf({ hostname: virtualHost, bucket, pathStyle: false });
    expect(canonicalizedResource(virtual, hostBucket)).toBe(canonicalizedResource(pathStyle));
  });

  it('path-style の設定ではhost名がbucketで始まってもbucketを足さない', () => {
    expect(hostBucketOf({ hostname: 'mmt.internal', bucket: 'mmt', pathStyle: true })).toBe(
      undefined,
    );
    expect(hostBucketOf({ hostname: 'mmt.internal', bucket: 'mmt', pathStyle: false })).toBe('mmt');
    // A dotted bucket over a plain endpoint is sent path-style by the SDK even without the flag.
    expect(hostBucketOf({ hostname: 'minio.internal', bucket: 'a.b', pathStyle: false })).toBe(
      undefined,
    );
  });
});

describe('署名v2: SDKへ渡すsign', () => {
  const signingDate = new Date('2026-10-08T06:00:00Z');
  class FakeHttpRequest implements S3SignableRequest {
    method = 'GET';
    hostname = 'minio.internal';
    path = '/mmt-artifacts/a.txt';
    query = {};
    headers: Record<string, string> = {
      Authorization: 'AWS stale:signature',
      Date: 'Mon, 01 Jan 2001 00:00:00 GMT',
    };
  }

  it('前回の試行のDateとAuthorizationを置き換え、一時credentialのtokenも署名する', async () => {
    const original = new FakeHttpRequest();
    const signed = await signS3RequestV2({
      request: original,
      credentials: async () => ({ ...credentials, sessionToken: 'session-token' }),
      bucket: 'mmt-artifacts',
      pathStyle: true,
      signingDate,
    });
    expect(signed).toBeInstanceOf(FakeHttpRequest);
    expect(signed.headers).toEqual({
      date: 'Thu, 08 Oct 2026 06:00:00 GMT',
      'x-amz-security-token': 'session-token',
      authorization: 'AWS AKIAIOSFODNN7EXAMPLE:8meCx/wFZzEdj05ElbAGPWJ86u8=',
    });
    expect(original.headers.Authorization).toBe('AWS stale:signature');
  });
});
