import {test as base,expect as baseExpect} from '@playwright/test';
// Local Worker tests simulate independent client addresses. Production limits stay unchanged.
export const test=base.extend<{rateLimitIsolation:void}>({
 rateLimitIsolation:[async({context},use,testInfo)=>{
  await context.setExtraHTTPHeaders({'CF-Connecting-IP':`e2e-${testInfo.testId}`});
  await use();
 },{auto:true}]
});
export const expect=baseExpect.configure({timeout:15000});
