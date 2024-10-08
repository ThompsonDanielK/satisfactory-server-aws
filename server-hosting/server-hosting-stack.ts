import { Duration, Stack, StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3_assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { Config } from "./config";

export class ServerHostingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // prefix for all resources in this stack
    const prefix = Config.prefix;

    //////////////////////////////////////////
    // Configure server, network and security
    //////////////////////////////////////////

    let lookUpOrDefaultVpc = (vpcId: string): ec2.IVpc => {
      if (vpcId) {
        return ec2.Vpc.fromLookup(this, `${prefix}Vpc`, {
          vpcId,
        });
      } else {
        return ec2.Vpc.fromLookup(this, `${prefix}Vpc`, {
          isDefault: true,
        });
      }
    };

    let publicOrLookupSubnet = (
      subnetId: string,
      availabilityZone: string
    ): ec2.SubnetSelection => {
      if (subnetId && availabilityZone) {
        return {
          subnets: [
            ec2.Subnet.fromSubnetAttributes(
              this,
              `${Config.prefix}ServerSubnet`,
              {
                availabilityZone,
                subnetId,
              }
            ),
          ],
        };
      } else {
        return { subnetType: ec2.SubnetType.PUBLIC };
      }
    };

    const vpc = lookUpOrDefaultVpc(Config.vpcId);
    const vpcSubnets = publicOrLookupSubnet(
      Config.subnetId,
      Config.availabilityZone
    );

    const securityGroup = new ec2.SecurityGroup(
      this,
      `${prefix}ServerSecurityGroup`,
      {
        vpc,
        description: "Allow Satisfactory client to connect to server",
      }
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(7777),
      "Game port"
    );
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(7777),
      "Game port 2"
    );
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(15000),
      "Beacon port"
    );
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(15777),
      "Query port"
    );

    const server = new ec2.Instance(this, `${prefix}Server`, {
      instanceType: new ec2.InstanceType("m5a.large"),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id"
      ),
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: ec2.BlockDeviceVolume.ebs(15),
        },
      ],
      vpcSubnets,
      userDataCausesReplacement: true,
      vpc,
      securityGroup,
    });

    server.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    //////////////////////////////
    // Configure save bucket
    //////////////////////////////

    let findOrCreateBucket = (bucketName: string): s3.IBucket => {
      if (bucketName) {
        return s3.Bucket.fromBucketName(
          this,
          `${prefix}SavesBucket`,
          bucketName
        );
      } else {
        return new s3.Bucket(this, `${prefix}SavesBucket`);
      }
    };

    const savesBucket = findOrCreateBucket(Config.bucketName);
    savesBucket.grantReadWrite(server.role);

    //////////////////////////////
    // Configure instance startup
    //////////////////////////////

    server.userData.addCommands("sudo apt-get install unzip -y");
    server.userData.addCommands(
      'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && unzip awscliv2.zip && sudo ./aws/install'
    );

    // Download the startup script
    const startupScript = new s3_assets.Asset(
      this,
      `${Config.prefix}InstallAsset`,
      {
        path: "./server-hosting/scripts/install.sh",
      }
    );
    startupScript.grantRead(server.role);

    const localPath = server.userData.addS3DownloadCommand({
      bucket: startupScript.bucket,
      bucketKey: startupScript.s3ObjectKey,
    });

    const useDuckDns = !!(Config.duckDnsDomain && Config.duckDnsToken);

    // Ensure correct line endings and execute the script with permissions
    server.userData.addCommands(`\
      sed -i 's/\r$//' ${localPath}; \
      chmod +x ${localPath}; \
      sudo ${localPath} ${savesBucket.bucketName} ${Config.useExperimentalBuild} ${useDuckDns} ${Config.duckDnsDomain} ${Config.duckDnsToken}\
    `);

    //////////////////////////////
    // Add api to start server
    //////////////////////////////

    if (Config.restartApi && Config.restartApi === true) {
      const startServerLambda = new lambda_nodejs.NodejsFunction(
        this,
        `${Config.prefix}StartServerLambda`,
        {
          entry: "./server-hosting/lambda/index.ts",
          description: "Restart game server",
          timeout: Duration.seconds(10),
          runtime: lambda.Runtime.NODEJS_20_X,
          environment: {
            INSTANCE_ID: server.instanceId,
          },
        }
      );

      startServerLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ec2:StartInstances"],
          resources: [
            `arn:aws:ec2:*:${Config.account}:instance/${server.instanceId}`,
          ],
        })
      );

      new apigw.LambdaRestApi(this, `${Config.prefix}StartServerApi`, {
        handler: startServerLambda,
        description: "Trigger lambda function to start server",
      });
    }
  }
}
