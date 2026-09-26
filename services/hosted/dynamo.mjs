/** DynamoDB adapter. SDK is injected so repository contracts can be tested without AWS. */
export function dynamoStore({client,commands,table}) {
  const send=(name,input)=>client.send(new commands[name]({TableName:table,...input}));
  return {
    async get(key){return (await send('GetCommand',{Key:key,ConsistentRead:true})).Item;},
    async query(pk,prefix){
      const items=[];let cursor;
      do {const page=await send('QueryCommand',{KeyConditionExpression:prefix?'pk = :pk AND begins_with(sk, :prefix)':'pk = :pk',ExpressionAttributeValues:{':pk':pk,...(prefix?{':prefix':prefix}:{})},ConsistentRead:true,...(cursor?{ExclusiveStartKey:cursor}:{})});items.push(...(page.Items??[]));cursor=page.LastEvaluatedKey;}while(cursor);
      return items;
    },
    async pendingBots(){
      const items=[];let cursor;
      do {const page=await send('QueryCommand',{IndexName:'PendingBots',KeyConditionExpression:'botPending = :pending',ExpressionAttributeValues:{':pending':'BOT'},...(cursor?{ExclusiveStartKey:cursor}:{})});items.push(...(page.Items??[]));cursor=page.LastEvaluatedKey;}while(cursor);
      return items.map(item=>item.pk.slice(5));
    },
    async transact(writes){
      try {await send('TransactWriteCommand',{TransactItems:writes.map(write=>{
        const condition=write.absent?{ConditionExpression:'attribute_not_exists(pk)'}:write.revision!==undefined?{ConditionExpression:'revision = :revision',ExpressionAttributeValues:{':revision':write.revision}}:{};
        return write.check?{ConditionCheck:{TableName:table,Key:write.check,...condition}}:{Put:{TableName:table,Item:write.item,...condition}};
      })});}catch(error){
        // Capacity/permissions errors must remain errors, not fabricated game conflicts.
        if(error.name==='TransactionCanceledException'&&error.CancellationReasons?.some(r=>r.Code==='ConditionalCheckFailed'))throw Object.assign(new Error('Concurrent write'),{code:'CONFLICT'});
        throw error;
      }
    },
    async remove(keys){
      for(let i=0;i<keys.length;i+=25){
        let pending=keys.slice(i,i+25).map(Key=>({DeleteRequest:{Key}}));
        for(let attempt=0;pending.length;attempt++){
          if(attempt>=8)throw Error('Cleanup throttled; retry required');
          const response=await send('BatchWriteCommand',{RequestItems:{[table]:pending}});pending=response.UnprocessedItems?.[table]??[];
          if(pending.length)await new Promise(resolve=>setTimeout(resolve,Math.min(100*2**attempt,5000)));
        }
      }
    },
    async rate(key,limit,now){
      const bucket=Math.floor(now/60000);
      try{await send('UpdateCommand',{Key:{pk:`RATE#${key}#${bucket}`,sk:'COUNT'},UpdateExpression:'SET #count = if_not_exists(#count, :zero) + :one, #ttl = :ttl',ConditionExpression:'attribute_not_exists(#count) OR #count < :limit',ExpressionAttributeNames:{'#count':'count','#ttl':'ttl'},ExpressionAttributeValues:{':zero':0,':one':1,':limit':limit,':ttl':Math.floor(now/1000)+120}});}catch(error){if(error.name==='ConditionalCheckFailedException')throw Object.assign(new Error('Too many requests. Try again shortly.'),{code:'RATE_LIMITED',status:429});throw error;}
    }
  };
}
