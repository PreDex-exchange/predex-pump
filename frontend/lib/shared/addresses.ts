// Runtime bridge to the shared source of truth. The shared package currently exports
// only its root barrel and ABI wildcard; direct module imports avoid that barrel's
// pre-existing duplicate `Address` type export without copying any chain values.
export { ADDRESSES, ARC, DEPLOY_BLOCK } from '../../../shared/src/addresses';
