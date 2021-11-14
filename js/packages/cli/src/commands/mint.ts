import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  getCandyMachineAddress,
  getMasterEdition,
  getMetadata,
  getTokenWallet,
  loadCandyProgram,
  loadWalletKey,
  uuidFromConfigPubkey,
} from '../helpers/accounts';
import {
  TOKEN_METADATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../helpers/constants';
import * as anchor from '@project-serum/anchor';
import { MintLayout, Token } from '@solana/spl-token';
import { createAssociatedTokenAccountInstruction } from '../helpers/instructions';
import { sendTransactionWithRetryWithKeypair } from '../helpers/transactions';


/*
so i think it's going to be minting a limited edition here

this means there are lots of moving parts
1. create the mint account for the edition 
2. 
*/
export async function mint(
  keypair: string,
  env: string,
  configAddress: PublicKey,
): Promise<string> {
  const mint = Keypair.generate();

  const userKeyPair = loadWalletKey(keypair);
  const anchorProgram = await loadCandyProgram(userKeyPair, env);
  //this is a helper that gets the expected associated account address for the wallet and the mint id
  //https://github.com/metaplex-foundation/metaplex/blob/master/js/packages/cli/src/helpers/accounts.ts#L71
  const userTokenAccountAddress = await getTokenWallet(
    userKeyPair.publicKey,
    mint.publicKey,
  );

  const uuid = uuidFromConfigPubkey(configAddress);
  const [candyMachineAddress] = await getCandyMachineAddress(
    configAddress,
    uuid,
  );
  const candyMachine: any = await anchorProgram.account.candyMachine.fetch(
    candyMachineAddress,
  );

  const remainingAccounts = [];
  const signers = [mint, userKeyPair];
  const instructions = [
    //create the account that is going to hold the mint 
    //on spl library, you can combine these first two into createMint()
    //high level what's happening is you are creating an account and then assigning it the mint data fields - https://docs.rs/spl-token/3.2.0/spl_token/state/struct.Mint.html
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: userKeyPair.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MintLayout.span,
      lamports:
        await anchorProgram.provider.connection.getMinimumBalanceForRentExemption(
          MintLayout.span,
        ),
      programId: TOKEN_PROGRAM_ID,
    }),
    //https://github.com/solana-labs/solana-program-library/blob/master/token/js/client/token.js#L1425
     /**
   * Construct an InitializeMint instruction
   *
   * @param programId SPL Token program account
   * @param mint Token mint account
   * @param decimals Number of decimals in token account amounts
   * @param mintAuthority Minting authority
   * @param freezeAuthority Optional authority that can freeze token accounts
   */
    Token.createInitMintInstruction(
      TOKEN_PROGRAM_ID,
      mint.publicKey,
      0,
      userKeyPair.publicKey,
      userKeyPair.publicKey,
    ),
    //this is creating a token account associated with the user's wallet
    //not sure if there's a check to make it fail if one already exists (or if you need to do that. might just fail automatically so doesn't matter)
    //https://github.com/metaplex-foundation/metaplex/blob/master/js/packages/cli/src/helpers/instructions.ts
    createAssociatedTokenAccountInstruction(
      userTokenAccountAddress,
      //payer
      userKeyPair.publicKey,
      //wallet address
      userKeyPair.publicKey,
      mint.publicKey,
    ),
    //https://github.com/solana-labs/solana-program-library/blob/2122e68d34db9502ca3254b241bfb4785ffc64e2/token/js/client/token.js#L1731
    //programid, mint, dest, auth, multisigners, amount
    //userkeypair is also the authority in this situation
    Token.createMintToInstruction(
      TOKEN_PROGRAM_ID,
      mint.publicKey,
      userTokenAccountAddress,
      userKeyPair.publicKey,
      [],
      1,
    ),
  ];

  let tokenAccount;
  if (candyMachine.tokenMint) {
    const transferAuthority = anchor.web3.Keypair.generate();

    tokenAccount = await getTokenWallet(
      userKeyPair.publicKey,
      candyMachine.tokenMint,
    );

    remainingAccounts.push({
      pubkey: tokenAccount,
      isWritable: true,
      isSigner: false,
    });
    remainingAccounts.push({
      pubkey: userKeyPair.publicKey,
      isWritable: false,
      isSigner: true,
    });

    //program id, pubkey of token account that's delegating, delegate to receive permission, owner of source token account, multisigners, amount 
    instructions.push(
      Token.createApproveInstruction(
        TOKEN_PROGRAM_ID,
        tokenAccount,
        transferAuthority.publicKey,
        userKeyPair.publicKey,
        [],
        candyMachine.data.price.toNumber(),
      ),
    );
  }
  //https://github.com/metaplex-foundation/metaplex/blob/master/js/packages/cli/src/helpers/accounts.ts#L175
  const metadataAddress = await getMetadata(mint.publicKey);
  //https://github.com/metaplex-foundation/metaplex/blob/master/js/packages/cli/src/helpers/accounts.ts#L190
  const masterEdition = await getMasterEdition(mint.publicKey);

  //before you can have the 1 of 10k mint, you have to set up the metadata and the master edition
  

  //this is the thing that's going to mint the limited edition to the user's wallet -- not lim ed
  // - so that's why he was saying like people were using the candy machine address as a collection identifier
  // so this is literally what's doing all of it then
  instructions.push(
    await anchorProgram.instruction.mintNft({
      accounts: {
        config: configAddress,
        candyMachine: candyMachineAddress,
        payer: userKeyPair.publicKey,
        //@ts-ignore
        wallet: candyMachine.wallet,
        mint: mint.publicKey,
        metadata: metadataAddress,
        masterEdition,
        mintAuthority: userKeyPair.publicKey,
        updateAuthority: userKeyPair.publicKey,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
      remainingAccounts,
    }),
  );

  if (tokenAccount) {
    instructions.push(
      Token.createRevokeInstruction(
        TOKEN_PROGRAM_ID,
        tokenAccount,
        userKeyPair.publicKey,
        [],
      ),
    );
  }

  return (
    await sendTransactionWithRetryWithKeypair(
      anchorProgram.provider.connection,
      userKeyPair,
      instructions,
      signers,
    )
  ).txid;
}
