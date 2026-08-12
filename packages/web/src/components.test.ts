// @vitest-environment jsdom
import{describe,expect,it}from'vitest';import{mount}from'@vue/test-utils';import ApprovalSheet from'./components/ApprovalSheet.vue';
import ComposerBox from'./components/ComposerBox.vue';
import AppShell from'./components/AppShell.vue';
import SessionSidebar from'./components/SessionSidebar.vue';
import NewThreadDialog from'./components/NewThreadDialog.vue';
import MessageBubble from'./components/MessageBubble.vue';
import ConversationTimeline from'./components/ConversationTimeline.vue';
const approval={request_id:'1:1',session_id:'s',kind:'item/commandExecution/requestApproval',payload:{command:'test'},status:'pending' as const,created_at:'x',updated_at:'x'};
describe('approval decisions',()=>{
 it('emits an accept decision',async()=>{const wrapper=mount(ApprovalSheet,{props:{open:true,approvals:[approval]}});expect(wrapper.text()).toContain('Codex 请求确认');await wrapper.find('button.primary').trigger('click');expect(wrapper.emitted('decide')?.[0]).toEqual([approval,'accept'])});
 it('does not allow remote permission grants',()=>{const wrapper=mount(ApprovalSheet,{props:{open:true,approvals:[{...approval,kind:'item/permissions/requestApproval'}]}});expect(wrapper.text()).toContain('只能拒绝');expect(wrapper.find('button.primary').attributes('disabled')).toBeDefined()});
});

const composerProps={disabled:false,activeTurn:false,online:true,queued:0,sending:false,models:[],skills:[],apps:[],defaults:{},capabilitiesLoading:false,cwd:''};
describe('composer settings panels',()=>{
 it('keeps access approval separate from model settings',async()=>{
  const wrapper=mount(ComposerBox,{props:composerProps});
  await wrapper.get('button.combined-access').trigger('click');
  expect(wrapper.find('.access-popover').exists()).toBe(true);
  expect(wrapper.find('.model-settings-popover').exists()).toBe(false);
  expect(wrapper.get('.access-popover').text()).toContain('请求批准');
  expect(wrapper.get('.access-popover').text()).not.toContain('推理强度');
  await wrapper.get('button.runtime-pill').trigger('click');
  expect(wrapper.find('.access-popover').exists()).toBe(false);
  expect(wrapper.find('.model-settings-popover').exists()).toBe(true);
  expect(wrapper.get('.model-settings-popover').text()).toContain('推理强度');
  expect(wrapper.get('.model-settings-popover').text()).not.toContain('请求批准');
 });
 it('opens reasoning choices as a model subpanel',async()=>{
  const wrapper=mount(ComposerBox,{props:composerProps});
  await wrapper.get('button.runtime-pill').trigger('click');
  await wrapper.findAll('.model-settings-root button')[1].trigger('click');
  expect(wrapper.find('.effort-choice-panel').exists()).toBe(true);
  expect(wrapper.find('.model-settings-root').exists()).toBe(false);
 });
 it('anchors panels to their buttons and closes them outside',async()=>{
  const wrapper=mount(ComposerBox,{props:composerProps,attachTo:document.body});
  await wrapper.get('button.combined-access').trigger('click');
  expect(wrapper.find('.composer-access-anchor .access-popover').exists()).toBe(true);
  document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));
  await wrapper.vm.$nextTick();
  expect(wrapper.find('.access-popover').exists()).toBe(false);
  wrapper.unmount();
 });
});

describe('application sidebar toggle',()=>{
 it('stays at the app shell and emits the toggle action',async()=>{
  const wrapper=mount(AppShell,{props:{drawerOpen:false,sidebarHidden:false}});
  const button=wrapper.get('button.app-sidebar-toggle');
  expect(button.attributes('aria-label')).toBe('隐藏侧边栏');
  await button.trigger('click');
  expect(wrapper.emitted('toggleSidebar')).toHaveLength(1);
  await wrapper.setProps({sidebarHidden:true});
  expect(button.attributes('aria-label')).toBe('显示侧边栏');
 });
});

describe('new conversation flow',()=>{
 it('emits create from the sidebar button',async()=>{
  const wrapper=mount(SessionSidebar,{props:{sessions:[],loading:false,error:'',busy:false}});
  await wrapper.get('button.new-thread').trigger('click');
  expect(wrapper.emitted('create')).toHaveLength(1);
 });
 it('submits a trimmed workspace path from the dialog',async()=>{
  const wrapper=mount(NewThreadDialog,{props:{open:true,initial:' E:\\Codex Remote APP ',busy:false,error:''}});
  await wrapper.get('.dialog-tabs button:last-child').trigger('click');
  await wrapper.get('.new-thread-dialog button.primary').trigger('click');
  expect(wrapper.emitted('create')?.[0]).toEqual(['E:\\Codex Remote APP']);
 });
});

describe('message rendering controls',()=>{
 it('renders markdown math and message copy controls',async()=>{
  const wrapper=mount(MessageBubble,{props:{message:{msg_id:'m1',session_id:'s',role:'assistant',content:'**结果** $x^2$',timestamp:'2026-01-01T00:00:00Z',seq:1}}});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(wrapper.find('.katex').exists()).toBe(true);
  expect(wrapper.find('button.assistant-copy').exists()).toBe(true);
 });
 it('hides an explicitly interrupted turn',()=>{
  const wrapper=mount(ConversationTimeline,{props:{messages:[{msg_id:'u1',turn_id:'t1',session_id:'s',role:'user',content:'cancelled prompt',timestamp:'2026-01-01T00:00:00Z',seq:1},{msg_id:'u2',turn_id:'t2',session_id:'s',role:'user',content:'kept prompt',timestamp:'2026-01-01T00:00:02Z',seq:3}],events:[{id:'e1',type:'turn_completed',session:'s',timestamp:'2026-01-01T00:00:01Z',seq:2,metadata:{turn_id:'t1',status:'interrupted'}}],loading:false,pendingStates:{}}});
  expect(wrapper.text()).not.toContain('cancelled prompt');
  expect(wrapper.text()).toContain('kept prompt');
 });
});
