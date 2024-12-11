"use strict";

const cfnresponse = require("cfn-response"),
  fs = require("fs"),
  path = require("path"),
  cp = require("child_process");

const {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const s3 = new S3Client();

exports.handler = async (event, context) => {
  let physicalResourceId = null,
    status = null;
  try {
    console.log(JSON.stringify(event));

    const bucket = event.ResourceProperties.Bucket,
      keyTarget = event.ResourceProperties.KeyTarget;
    physicalResourceId = `arn:aws:s3:::${bucket}/${keyTarget}`;

    if (event.RequestType == "Create") {
      await createZip(event);
    } else if (event.RequestType == "Update") {
      await createZip(event);

      const oldPhysicalResourceId = event.PhysicalResourceId;

      if (physicalResourceId != oldPhysicalResourceId) {
        await deleteZip(oldPhysicalResourceId);
      }
    } else if (event.RequestType == "Delete") {
      const physicalResourceId = event.PhysicalResourceId;

      await deleteZip(physicalResourceId);
    } else {
      throw new Error("unknown event.RequestType: " + event.RequestType);
    }

    status = cfnresponse.SUCCESS;
  } catch (error) {
    console.log(error);
    status = cfnresponse.FAILED;
  } finally {
    // cfnresponse calls context.done() when it has finished
    cfnresponse.send(event, context, status, {}, physicalResourceId);
    await new Promise(function (resolve) {});
  }
};

async function createZip(event) {
  const p = event.ResourceProperties,
    bucket = p.Bucket,
    keySource = p.KeySource,
    keyTarget = p.KeyTarget,
    env = Object.assign({}, process.env);

  env.HOME = "/tmp"; // npm writes to home dir which is readonly in Lambda

  const exec = (cmd, cwd) => cp.execSync(cmd, { cwd, env, stdio: "inherit" });

  console.log("Installing yazl");
  exec("npm install yazl unzipper", "/tmp");
  const yazl = require("/tmp/node_modules/yazl"),
    unzipper = require("/tmp/node_modules/unzipper");

  const downloadPath = "/tmp/source.zip";
  console.log(`Downloading s3://${bucket}/${keySource} to ${downloadPath}`);
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: keySource })
  );
  const body = await obj.Body.transformToByteArray();
  await new Promise((resolve) => {
    const s = fs.createWriteStream(downloadPath);
    s.on("finish", resolve);
    s.write(body);
    s.end();
  });

  const buildPath = "/tmp/build";
  console.log(`Preparing build path ${buildPath}`);
  exec(`rm -rf ${buildPath}`);
  exec(`mkdir ${buildPath}`);
  process.chdir(buildPath);

  console.log(`Extracting ${downloadPath} to ${buildPath}`);
  await new Promise((resolve) => {
    fs.createReadStream(downloadPath).pipe(
      unzipper.Extract({ path: buildPath }).on("close", resolve)
    );
  });
  fs.unlinkSync(downloadPath);

  console.log("Running build script");
  fs.chmodSync("./build.sh", "755");
  exec("ls -alh");
  exec("./build.sh");

  const builtPath = "/tmp/built.zip";
  console.log(`Creating ${builtPath} from ${buildPath}`);
  await new Promise((resolve) => {
    const zipfile = new yazl.ZipFile();
    zipfile.outputStream
      .pipe(fs.createWriteStream(builtPath))
      .on("close", resolve);
    for (const absPath of walkSync(buildPath)) {
      const relPath = path.relative(buildPath, absPath);
      zipfile.addFile(absPath, relPath);
    }
    zipfile.end();
  });

  console.log(`Uploading zip to s3://${bucket}/${keyTarget}`);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keyTarget,
      Body: fs.createReadStream(builtPath),
    })
  );
}

async function deleteZip(resourceId) {
  const arnParts = resourceId.split(":"),
    bucketAndKey = arnParts[arnParts.length - 1],
    bucket = bucketAndKey.substring(0, bucketAndKey.indexOf("/")),
    key = bucketAndKey.substring(bucketAndKey.indexOf("/") + 1);

  console.log(`Deleting s3://${bucket}/${key}`);
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

function* walkSync(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fpath = path.join(dir, file),
      isDir = fs.statSync(fpath).isDirectory();
    if (isDir) {
      yield* walkSync(fpath);
    } else {
      yield fpath;
    }
  }
}
