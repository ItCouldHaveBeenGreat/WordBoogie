#!/usr/bin/env bash
# Run from the repository root in AWS CloudShell (or a federated AWS CLI session).
set -euo pipefail
region=us-west-2
bootstrap_stack=wordboogie-bootstrap
application_stack=wordboogie-production
repository=ItCouldHaveBeenGreat/WordBoogie
aws sts get-caller-identity --query '{Account:Account,Identity:Arn}' --output table
existing_stack=$(aws cloudformation list-stacks --region "$region" --query "StackSummaries[?StackName=='$bootstrap_stack' && StackStatus!='DELETE_COMPLETE'].StackId | [0]" --output text)
if [[ "$existing_stack" != None && -n "$existing_stack" ]]; then
  provider=$(aws cloudformation describe-stacks --region "$region" --stack-name "$bootstrap_stack" --query "Stacks[0].Parameters[?ParameterKey=='ExistingGitHubProviderArn'].ParameterValue | [0]" --output text)
else
  provider=$(aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, '/token.actions.githubusercontent.com')].Arn | [0]" --output text)
fi
if [[ "$provider" == None ]]; then provider=''; fi
aws cloudformation deploy --region "$region" --template-file infra/bootstrap.json --stack-name "$bootstrap_stack" --capabilities CAPABILITY_IAM --parameter-overrides "GitHubRepository=$repository" "ApplicationStackName=$application_stack" "ExistingGitHubProviderArn=$provider" --no-fail-on-empty-changeset
aws cloudformation describe-stacks --region "$region" --stack-name "$bootstrap_stack" --query 'Stacks[0].Outputs' --output table
printf '\nCopy outputs to GitHub repository Actions variables:\nArtifactBucket -> AWS_ARTIFACT_BUCKET\nDeployRoleArn -> AWS_DEPLOY_ROLE_ARN\nCloudFormationRoleArn -> AWS_CFN_ROLE_ARN\nRuntimeBoundaryArn -> AWS_RUNTIME_BOUNDARY_ARN\nFRONTEND_URL -> https://itcouldhavebeengreat.github.io/WordBoogie\n'
