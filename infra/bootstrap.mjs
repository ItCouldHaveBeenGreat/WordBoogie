import { writeFileSync } from 'node:fs';
const ref=Ref=>({Ref}),sub=s=>({'Fn::Sub':s}),attr=(r,a)=>({'Fn::GetAtt':[r,a]});
const allow=(Action,Resource,Condition)=>({Effect:'Allow',Action,Resource,...(Condition?{Condition}:{})});
const arn=(service,path,region='${AWS::Region}')=>sub(`arn:\${AWS::Partition}:${service}:${region}:\${AWS::AccountId}:${path}`);
const stack=arn('cloudformation','stack/${ApplicationStackName}/*');
const appRoles=arn('iam','role/${ApplicationStackName}-*','');
const runtimePolicy={Version:'2012-10-17',Statement:[
 allow(['dynamodb:GetItem','dynamodb:Query','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:ConditionCheckItem','dynamodb:BatchWriteItem','dynamodb:DescribeStream','dynamodb:GetRecords','dynamodb:GetShardIterator'],[arn('dynamodb','table/${ApplicationStackName}-*'),arn('dynamodb','table/${ApplicationStackName}-*/index/*'),arn('dynamodb','table/${ApplicationStackName}-*/stream/*')]),
 allow(['dynamodb:ListStreams'],'*'),
 allow(['logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents'],arn('logs','log-group:/aws/lambda/${ApplicationStackName}-*')),
 allow(['sqs:SendMessage'],arn('sqs','${ApplicationStackName}-*'))
]};
const cfnPolicy={Version:'2012-10-17',Statement:[
 allow(['s3:GetObject'],sub('${ArtifactBucket.Arn}/wordboogie/*')),
 allow(['lambda:CreateFunction','lambda:GetFunction','lambda:GetFunctionConfiguration','lambda:UpdateFunctionCode','lambda:UpdateFunctionConfiguration','lambda:DeleteFunction','lambda:AddPermission','lambda:RemovePermission','lambda:GetPolicy','lambda:TagResource','lambda:UntagResource','lambda:ListTags','lambda:PutFunctionConcurrency','lambda:DeleteFunctionConcurrency','lambda:GetFunctionConcurrency','lambda:PutFunctionEventInvokeConfig','lambda:GetFunctionEventInvokeConfig','lambda:DeleteFunctionEventInvokeConfig'],arn('lambda','function:${ApplicationStackName}-*')),
 allow(['lambda:CreateEventSourceMapping','lambda:GetEventSourceMapping','lambda:UpdateEventSourceMapping','lambda:DeleteEventSourceMapping','lambda:ListEventSourceMappings','lambda:TagResource','lambda:UntagResource','lambda:ListTags'], '*'),
 allow(['apigateway:GET','apigateway:POST','apigateway:PUT','apigateway:PATCH','apigateway:DELETE'],sub('arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis*')),
 allow(['dynamodb:CreateTable','dynamodb:DescribeTable','dynamodb:UpdateTable','dynamodb:DeleteTable','dynamodb:DescribeTimeToLive','dynamodb:UpdateTimeToLive','dynamodb:DescribeContinuousBackups','dynamodb:UpdateContinuousBackups','dynamodb:TagResource','dynamodb:UntagResource','dynamodb:ListTagsOfResource'],arn('dynamodb','table/${ApplicationStackName}-*')),
 allow(['iam:CreateRole','iam:PutRolePermissionsBoundary'],appRoles,{'StringEquals':{'iam:PermissionsBoundary':ref('RuntimeBoundary')}}),
 allow(['iam:GetRole','iam:DeleteRole','iam:UpdateAssumeRolePolicy','iam:PutRolePolicy','iam:GetRolePolicy','iam:DeleteRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:TagRole','iam:UntagRole'],appRoles),
 allow(['iam:AttachRolePolicy','iam:DetachRolePolicy'],appRoles,{'ArnEquals':{'iam:PolicyARN':[sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'),sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole')]}}),
 allow(['iam:PassRole'],appRoles,{'StringEquals':{'iam:PassedToService':'lambda.amazonaws.com'}}),
 allow(['logs:DescribeLogGroups'],'*',{'StringEquals':{'aws:RequestedRegion':ref('AWS::Region')}}),
 allow(['logs:CreateLogGroup','logs:PutRetentionPolicy','logs:DeleteRetentionPolicy','logs:DeleteLogGroup','logs:TagResource','logs:UntagResource','logs:ListTagsForResource'],arn('logs','log-group:/aws/lambda/${ApplicationStackName}-*')),
 allow(['events:PutRule','events:DescribeRule','events:DeleteRule','events:PutTargets','events:RemoveTargets','events:ListTargetsByRule','events:TagResource','events:UntagResource'],arn('events','rule/${ApplicationStackName}-*')),
 allow(['sqs:CreateQueue','sqs:GetQueueAttributes','sqs:GetQueueUrl','sqs:SetQueueAttributes','sqs:DeleteQueue','sqs:TagQueue','sqs:UntagQueue','sqs:ListQueueTags'],arn('sqs','${ApplicationStackName}-*')),
 allow(['sns:CreateTopic','sns:DeleteTopic','sns:GetTopicAttributes','sns:SetTopicAttributes','sns:Subscribe','sns:TagResource','sns:UntagResource','sns:ListTagsForResource'],arn('sns','${ApplicationStackName}-*')),
 allow(['sns:GetSubscriptionAttributes','sns:SetSubscriptionAttributes','sns:Unsubscribe'],arn('sns','${ApplicationStackName}-*:*')),
 allow(['cloudwatch:PutMetricAlarm','cloudwatch:DescribeAlarms','cloudwatch:DeleteAlarms','cloudwatch:TagResource','cloudwatch:UntagResource','cloudwatch:ListTagsForResource'],arn('cloudwatch','alarm:${ApplicationStackName}-*')),
 // Cognito's generated pool IDs and regional creation APIs cannot be scoped by stack-name prefixes.
 allow(['cognito-idp:CreateUserPool','cognito-idp:DescribeUserPool','cognito-idp:UpdateUserPool','cognito-idp:DeleteUserPool','cognito-idp:CreateUserPoolClient','cognito-idp:DescribeUserPoolClient','cognito-idp:UpdateUserPoolClient','cognito-idp:DeleteUserPoolClient','cognito-idp:CreateUserPoolDomain','cognito-idp:DescribeUserPoolDomain','cognito-idp:UpdateUserPoolDomain','cognito-idp:DeleteUserPoolDomain','cognito-idp:CreateResourceServer','cognito-idp:DescribeResourceServer','cognito-idp:UpdateResourceServer','cognito-idp:DeleteResourceServer','cognito-idp:TagResource','cognito-idp:UntagResource','cognito-idp:ListTagsForResource'], '*',{'StringEquals':{'aws:RequestedRegion':ref('AWS::Region')}}),
 allow(['budgets:ModifyBudget','budgets:ViewBudget'],arn('budgets','budget/${ApplicationStackName}-monthly',''))
]};
const resources={
 ArtifactBucket:{Type:'AWS::S3::Bucket',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true},OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]},BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]},LifecycleConfiguration:{Rules:[{Id:'AbandonedMultipartUploads',Status:'Enabled',AbortIncompleteMultipartUpload:{DaysAfterInitiation:1}}]}}},
 ArtifactBucketPolicy:{Type:'AWS::S3::BucketPolicy',Properties:{Bucket:ref('ArtifactBucket'),PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Deny',Principal:'*',Action:'s3:*',Resource:[attr('ArtifactBucket','Arn'),sub('${ArtifactBucket.Arn}/*')],Condition:{Bool:{'aws:SecureTransport':'false'}}}]}}},
 GitHubProvider:{Type:'AWS::IAM::OIDCProvider',Condition:'CreateProvider',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Url:'https://token.actions.githubusercontent.com',ClientIdList:['sts.amazonaws.com']}},
 RuntimeBoundary:{Type:'AWS::IAM::ManagedPolicy',Properties:{Description:'Maximum permissions for WordBoogie runtime functions',PolicyDocument:runtimePolicy}},
 CloudFormationRole:{Type:'AWS::IAM::Role',Properties:{AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'cloudformation.amazonaws.com'},Action:'sts:AssumeRole'}]},Policies:[{PolicyName:'ApplicationProvisioning',PolicyDocument:cfnPolicy}]}},
 GitHubDeployRole:{Type:'AWS::IAM::Role',Properties:{MaxSessionDuration:3600,AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Federated:{'Fn::If':['CreateProvider',ref('GitHubProvider'),ref('ExistingGitHubProviderArn')]}},Action:'sts:AssumeRoleWithWebIdentity',Condition:{StringEquals:{'token.actions.githubusercontent.com:aud':'sts.amazonaws.com','token.actions.githubusercontent.com:sub':sub('repo:${GitHubRepository}:environment:production')}}}]},Policies:[{PolicyName:'DeployApplication',PolicyDocument:{Version:'2012-10-17',Statement:[
 allow(['s3:ListBucket','s3:GetBucketLocation'],attr('ArtifactBucket','Arn')),allow(['s3:GetObject','s3:PutObject','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'],sub('${ArtifactBucket.Arn}/wordboogie/*')),
 allow(['cloudformation:CreateChangeSet'],stack,{'ArnEquals':{'cloudformation:RoleArn':attr('CloudFormationRole','Arn')}}),
 allow(['cloudformation:DescribeChangeSet','cloudformation:ExecuteChangeSet','cloudformation:DeleteChangeSet','cloudformation:DescribeStacks','cloudformation:DescribeStackEvents','cloudformation:GetTemplate'],stack),
 allow(['cloudformation:ValidateTemplate','cloudformation:GetTemplateSummary'],'*'),allow(['iam:PassRole'],attr('CloudFormationRole','Arn'),{'StringEquals':{'iam:PassedToService':'cloudformation.amazonaws.com'}})
]}}]}}
};
const template={AWSTemplateFormatVersion:'2010-09-09',Description:'One-time WordBoogie deployment bootstrap: artifacts, GitHub OIDC, deployment roles and runtime boundary',Parameters:{GitHubRepository:{Type:'String',Default:'ItCouldHaveBeenGreat/WordBoogie',AllowedPattern:'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'},ApplicationStackName:{Type:'String',Default:'wordboogie-production',AllowedPattern:'[a-z][a-z0-9-]{1,39}'},ExistingGitHubProviderArn:{Type:'String',Default:'',Description:'Reuse the account GitHub OIDC provider if it already exists; leave blank to create it'}},Conditions:{CreateProvider:{'Fn::Equals':[ref('ExistingGitHubProviderArn'),'']}},Resources:resources,Outputs:{ArtifactBucket:{Value:ref('ArtifactBucket')},DeployRoleArn:{Value:attr('GitHubDeployRole','Arn')},CloudFormationRoleArn:{Value:attr('CloudFormationRole','Arn')},RuntimeBoundaryArn:{Value:ref('RuntimeBoundary')}}};
writeFileSync(new URL('./bootstrap.json',import.meta.url),JSON.stringify(template,null,2)+'\n');
console.log('Generated infra/bootstrap.json');
